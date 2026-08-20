import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { KubeCluster, KubeClusterDocument, KubePrometheusConfig } from './schemas/kube-cluster.schema';
import { Secret, SecretDocument } from '../secrets/schemas/secret.schema';
import { SecretsService } from '../secrets/secrets.service';
import { parseKubeconfig } from './kubeconfig-parser';
import { KubeTransportService, requireHttpsUrl } from './kube-transport.service';
import { isDuplicateKeyError } from '../common/narrow';
import { RequestContext } from '../common/request-context';
import { UserRole } from '../auth/schemas/user.schema';
import { CreateKubeClusterDto, KubePrometheusDto } from './dto/create-kube-cluster.dto';
import { UpdateKubeClusterDto } from './dto/update-kube-cluster.dto';

@Injectable()
export class KubeClustersService {
  constructor(
    @InjectModel(KubeCluster.name) private readonly clusterModel: Model<KubeClusterDocument>,
    @InjectModel(Secret.name) private readonly secretModel: Model<SecretDocument>,
    private readonly secretsService: SecretsService,
    private readonly transport: KubeTransportService,
  ) {}

  /**
   * Wandelt eine Id in eine ObjectId oder wirft. Nie einen ungeprüften Wert
   * in ein Mongo-Filter-Objekt geben: Mongoose entfernt `undefined`-Schlüssel
   * aus Filtern, die Bedingung verschwindet und die Abfrage trifft statt
   * "nichts" irgendetwas.
   */
  private toObjectId(value: string, field: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`${field} ist keine gültige ObjectId`);
    }
    return new Types.ObjectId(value);
  }

  /**
   * Normalisiert eine (unvollständige) Prometheus-DTO auf die vom Schema
   * verlangte Form. Das DTO lässt `path` optional (leerer Aufruf soll nicht
   * an einer Pflichtangabe scheitern), das Schema verlangt `path: string`
   * (mit Runtime-Default `'/'`, aber der TS-Typ der Klasse ist nicht
   * optional). Eine direkte Zuweisung `doc.prometheus = dto.prometheus`
   * scheitert deshalb unter strictNullChecks — und zwar an genau der Stelle,
   * an der ein Type-Assertion-Umweg verlockend wäre. Stattdessen wird der
   * fehlende Wert hier explizit befüllt.
   */
  private normalizePrometheus(dto: KubePrometheusDto | undefined): KubePrometheusConfig {
    if (!dto) {
      return { enabled: false, path: '/' };
    }
    return { ...dto, path: dto.path ?? '/' };
  }

  /**
   * readOnly=false und allowMcpWrites=true sind der eigentliche Hebel — ein
   * Kube-Cluster mit Schreibrechten, dazu für MCP-Tools freigegeben — und
   * laut Spec admin-only. Alles andere an Cluster-CRUD ist unreguliert, wie
   * bei SSH-Connections. Gilt für create() UND update(), nicht nur die Route:
   * beide sind die einzigen Schreibpfade auf diese Felder.
   *
   * Kein Actor (interner Aufrufer, z.B. Migration, MCP-Tool ohne HTTP-Kontext)
   * bleibt ungegated — dieselbe Konvention wie in SecretsService
   * (`if (actor && …)`): JwtAuthGuard hängt global, jeder echte HTTP-Aufruf
   * hat also einen Actor; ein fehlender Actor bedeutet einen vertrauenswürdigen
   * internen Aufrufer, keine Lücke.
   */
  private assertFlagPermission(dto: { readOnly?: boolean; allowMcpWrites?: boolean }): void {
    const actor = RequestContext.getUser();
    if (!actor) return;
    // `RequestUser.role` ist `string` (kommt aus JWT/DB, nicht aus dem
    // TS-Enum) — dieselbe Verbreiterung wie in RolesGuard.canActivate(),
    // damit der Vergleich keine Behauptung über den Enum-Ursprung macht.
    const adminRole: string = UserRole.ADMIN;
    if (actor.role === adminRole) return;
    if (dto.readOnly === false) {
      throw new ForbiddenException('readOnly=false erfordert Admin-Rechte');
    }
    if (dto.allowMcpWrites === true) {
      throw new ForbiddenException('allowMcpWrites=true erfordert Admin-Rechte');
    }
  }

  async create(dto: CreateKubeClusterDto): Promise<KubeClusterDocument> {
    this.assertFlagPermission(dto);
    // Scope-Invariante vorab prüfen, nicht dem Pre-Validate-Hook überlassen —
    // gleiche Begründung wie bei den Invarianten weiter unten: der Hook wirft
    // einen nackten Error, den Mongoose als ValidationError verpackt und Nest
    // als HTTP 500 mappt statt 400. Der Hook bleibt als letzte Verteidigung.
    if (!dto.projectId && !dto.customerId) {
      throw new BadRequestException('Genau eines von projectId / customerId ist erforderlich');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('projectId und customerId schließen sich gegenseitig aus');
    }

    const parsed = parseKubeconfig(dto.kubeconfig);
    const ctx = parsed.contexts.find((c) => c.contextName === dto.contextName);
    if (!ctx) {
      throw new BadRequestException(
        `context "${dto.contextName}" ist in der Kubeconfig nicht enthalten`,
      );
    }
    if (ctx.rejections.length > 0) {
      throw new BadRequestException(
        `Kubeconfig nicht verwendbar: ${ctx.rejections.join(', ')}. ` +
        'Exec-Credential-Plugins (aws/gcloud) laufen serverseitig nicht.',
      );
    }
    // Die Server-URL aus der Kubeconfig ist Caller-Input und landet
    // unverändert im `required: true`-Feld `clusterServer`. Zwei Dinge
    // müssen hier stimmen, und beide taten es nicht:
    //
    //  - **Form**: ein Context, der auf einen in der Datei fehlenden Cluster
    //    zeigt, parst anstandslos und liefert `server: ''`. Das lief in den
    //    Pre-Validate-Hook und kam als HTTP 500 beim Aufrufer an.
    //  - **Protokoll**: der Parser winkt `http://prod:8080` mit einer blossen
    //    `no_ca`-Warnung durch. So ein Cluster war anlegbar — und
    //    funktionierte dann auch, mit `Authorization: Bearer <token>` im
    //    Klartext auf der Leitung.
    //
    // Vor dem Anlegen des Secrets prüfen, sonst bliebe bei Ablehnung ein
    // verwaistes Secret zurück.
    requireHttpsUrl(ctx.server);
    const insecure = ctx.warnings.includes('insecure_tls') || ctx.warnings.includes('no_ca');
    if (insecure && dto.allowInsecureTls !== true) {
      throw new BadRequestException(
        'Kubeconfig ohne CA bzw. mit insecure-skip-tls-verify: allowInsecureTls muss explizit gesetzt werden',
      );
    }
    // Explizit prüfen, nicht dem Pre-Validate-Hook überlassen: der wirft einen
    // nackten Error, den Mongoose als ValidationError verpackt — Nest macht
    // daraus HTTP 500 statt 400. Der Hook bleibt als letzte Verteidigung.
    if ((dto.allowMcpWrites ?? false) && (dto.readOnly ?? true)) {
      throw new BadRequestException('allowMcpWrites setzt readOnly=false voraus');
    }
    if (dto.transport === 'ssh-tunnel' && !dto.sshConnectionId) {
      throw new BadRequestException('sshConnectionId ist bei transport="ssh-tunnel" erforderlich');
    }
    // Gleiche Klasse wie die Checks oben (Correction 3: keine Aufzählung,
    // sondern jede Caller-Input-Invariante). Ohne diesen Check würde
    // prometheus.enabled=true mit fehlendem namespace/service/port erst im
    // Pre-Validate-Hook auffallen und als 500 statt 400 beim Aufrufer landen.
    if (dto.prometheus?.enabled && (!dto.prometheus.namespace || !dto.prometheus.service || !dto.prometheus.port)) {
      throw new BadRequestException(
        'prometheus: namespace, service und port sind bei enabled=true erforderlich',
      );
    }

    const _id = new Types.ObjectId();
    // Der Secret-Key MUSS vom frischen Cluster-_id abhängen, nicht (nur) vom
    // Slug: SecretsService.create() ist kein Insert, sondern ein Upsert über
    // (Scope, environmentId, Key) — siehe secrets.service.ts. Zwei create()-
    // Aufrufe mit demselben Slug im selben Scope hätten mit einem rein
    // slug-basierten Key denselben Key getroffen: der zweite (zum Scheitern
    // verurteilte) Aufruf hätte dann das Secret des ERSTEN, erfolgreichen
    // Clusters überschrieben — und der Rollback hätte es anschließend
    // gelöscht. Der _id-Anteil macht den Key pro Aufruf einzigartig, der
    // Upsert kann also nur je einmal treffen: entweder als echter Insert
    // (Normalfall) oder — praktisch unerreichbar, da _id frisch generiert
    // ist — als Kollision mit sich selbst.
    const secret = await this.secretsService.create({
      projectId: dto.projectId,
      customerId: dto.customerId,
      key: `kubeconfig-${dto.slug}-${_id.toString()}`,
      value: dto.kubeconfig,
      type: 'file',
      description: `Kubeconfig für Cluster "${dto.label}"`,
    });
    const secretId = new Types.ObjectId(secret._id);

    try {
      await this.secretModel
        .updateOne({ _id: secretId }, { $set: { ownedByKubeClusterId: _id } })
        .exec();

      return await this.clusterModel.create({
        _id,
        label: dto.label,
        slug: dto.slug,
        projectId: dto.projectId ? this.toObjectId(dto.projectId, 'projectId') : undefined,
        customerId: dto.customerId ? this.toObjectId(dto.customerId, 'customerId') : undefined,
        kubeconfigSecretId: secretId,
        contextName: dto.contextName,
        clusterServer: ctx.server,
        defaultNamespace: dto.defaultNamespace ?? ctx.namespace,
        transport: dto.transport,
        sshConnectionId: dto.sshConnectionId
          ? this.toObjectId(dto.sshConnectionId, 'sshConnectionId')
          : undefined,
        readOnly: dto.readOnly ?? true,
        allowMcpWrites: dto.allowMcpWrites ?? false,
        allowInsecureTls: dto.allowInsecureTls ?? false,
        prometheus: this.normalizePrometheus(dto.prometheus),
        description: dto.description,
        tags: dto.tags ?? [],
      });
    } catch (err) {
      // Rollback: das eben angelegte Secret darf nicht verwaist zurückbleiben —
      // gilt für jeden Fehlerpfad hier, inklusive Duplicate-Slug unten.
      await this.secretModel.deleteMany({ _id: { $in: [secretId] } }).exec();
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Kube-Cluster-Slug "${dto.slug}" existiert in diesem Scope bereits`,
        );
      }
      throw err;
    }
  }

  async findById(id: string): Promise<KubeClusterDocument> {
    const doc = await this.clusterModel.findById(this.toObjectId(id, 'id')).exec();
    if (!doc) throw new NotFoundException(`Kube-Cluster ${id} nicht gefunden`);
    return doc;
  }

  async findByProjectId(projectId: string): Promise<KubeClusterDocument[]> {
    return this.clusterModel
      .find({ projectId: this.toObjectId(projectId, 'projectId') })
      .sort({ label: 1 })
      .exec();
  }

  async findByCustomerId(customerId: string): Promise<KubeClusterDocument[]> {
    return this.clusterModel
      .find({ customerId: this.toObjectId(customerId, 'customerId') })
      .sort({ label: 1 })
      .exec();
  }

  async findBySlug(
    slug: string,
    scope: { projectId?: string; customerId?: string },
  ): Promise<KubeClusterDocument> {
    if (!scope.projectId && !scope.customerId) {
      throw new BadRequestException('projectId oder customerId ist erforderlich');
    }
    const filter: Record<string, unknown> = { slug };
    if (scope.projectId) filter.projectId = this.toObjectId(scope.projectId, 'projectId');
    if (scope.customerId) filter.customerId = this.toObjectId(scope.customerId, 'customerId');
    const doc = await this.clusterModel.findOne(filter).exec();
    if (!doc) throw new NotFoundException(`Kube-Cluster "${slug}" nicht gefunden`);
    return doc;
  }

  async update(id: string, dto: UpdateKubeClusterDto): Promise<KubeClusterDocument> {
    this.assertFlagPermission(dto);
    // Keine Scope-Invariante hier zu prüfen: UpdateKubeClusterDto lässt
    // projectId/customerId absichtlich aus (Scope ist unveränderlich), also
    // rührt update() doc.projectId/doc.customerId nie an. Der Zustand, den
    // create() geprüft hat, bleibt über die gesamte Lebensdauer des
    // Dokuments erhalten — ein Check hier könnte nie auslösen.
    const doc = await this.findById(id);
    // Vorzustand des Transports festhalten: ein gecachter Tunnel gehört zur
    // ALTEN Bastion und muss weg, sobald sich hier etwas ändert (I2).
    const previousTransport = doc.transport;
    const previousSshConnectionId = doc.sshConnectionId?.toString();
    if (dto.label !== undefined) doc.label = dto.label;
    if (dto.defaultNamespace !== undefined) doc.defaultNamespace = dto.defaultNamespace;
    if (dto.transport !== undefined) doc.transport = dto.transport;
    if (dto.sshConnectionId !== undefined) {
      doc.sshConnectionId = this.toObjectId(dto.sshConnectionId, 'sshConnectionId');
    }
    if (dto.readOnly !== undefined) doc.readOnly = dto.readOnly;
    if (dto.allowMcpWrites !== undefined) doc.allowMcpWrites = dto.allowMcpWrites;
    if (dto.allowInsecureTls !== undefined) doc.allowInsecureTls = dto.allowInsecureTls;
    // Normalisiert wie in create(): das DTO lässt `prometheus.path` optional,
    // das Schema verlangt `path: string`. Siehe normalizePrometheus() oben —
    // kein `as`-Umweg, der Wert wird explizit befüllt.
    if (dto.prometheus !== undefined) doc.prometheus = this.normalizePrometheus(dto.prometheus);
    if (dto.description !== undefined) doc.description = dto.description;
    if (dto.tags !== undefined) doc.tags = dto.tags;

    // Gleiche Begründung wie in create(): 400 statt 500.
    if (doc.allowMcpWrites && doc.readOnly) {
      throw new BadRequestException('allowMcpWrites setzt readOnly=false voraus');
    }
    if (doc.transport === 'ssh-tunnel' && !doc.sshConnectionId) {
      throw new BadRequestException('sshConnectionId ist bei transport="ssh-tunnel" erforderlich');
    }
    // Anders als die Scope-Invariante IST diese hier über update() erreichbar:
    // UpdateKubeClusterDto lässt prometheus zu, und die Zuweisung oben
    // schreibt sie auf doc.prometheus. Ohne diesen Check würde ein Patch auf
    // enabled=true ohne namespace/service/port erst am Pre-Validate-Hook von
    // doc.save() scheitern — 500 statt 400.
    if (doc.prometheus?.enabled && (!doc.prometheus.namespace || !doc.prometheus.service || !doc.prometheus.port)) {
      throw new BadRequestException(
        'prometheus: namespace, service und port sind bei enabled=true erforderlich',
      );
    }

    await doc.save();

    // Ohne diesen Wurf tunnelte der Cluster bis zum Ablauf der Idle-TTL
    // (5 Minuten) weiter über den alten Bastion-Host — und weil K2s Polling
    // den Idle-Timer bei jedem Zugriff zurücksetzt, potenziell unbegrenzt
    // lange. Nur bei echter Änderung: Invalidieren schliesst den Tunnel
    // sofort, auch unter laufenden Requests, und für eine Umbenennung wäre
    // das grundlose Störung. Als Schlüssel die kanonische Id des Dokuments,
    // nicht den Roh-String aus der Route — der Cache ist über
    // `String(cluster._id)` verschlüsselt.
    if (
      doc.transport !== previousTransport ||
      doc.sshConnectionId?.toString() !== previousSshConnectionId
    ) {
      this.transport.invalidate(doc._id.toString());
    }
    return doc;
  }

  async delete(id: string): Promise<void> {
    const _id = this.toObjectId(id, 'id');
    await this.secretModel.deleteMany({ ownedByKubeClusterId: _id }).exec();
    await this.clusterModel.deleteOne({ _id }).exec();
    // Sonst überleben der Listener und der ssh2-Client die gelöschte
    // Entität — bis zum nächsten Backend-Neustart.
    this.transport.invalidate(_id.toString());
  }

  async recordConnectSuccess(id: string): Promise<KubeClusterDocument> {
    const doc = await this.findById(id);
    doc.lastConnectedAt = new Date();
    doc.lastConnectError = undefined;
    await doc.save();
    return doc;
  }

  async recordConnectError(id: string, message: string): Promise<KubeClusterDocument> {
    const doc = await this.findById(id);
    doc.lastConnectError = { at: new Date(), message: message.slice(0, 500) };
    await doc.save();
    return doc;
  }

  /**
   * Entschlüsselter Kubeconfig-Text. Ausschliesslich für interne Aufrufer
   * (KubeClientService, Terminal-Session). Darf nie in eine HTTP-Response.
   */
  async readKubeconfig(cluster: KubeClusterDocument): Promise<string> {
    const secret = await this.secretsService
      .findById(cluster.kubeconfigSecretId.toString())
      .catch(() => {
        throw new NotFoundException('Kubeconfig-Secret fehlt oder ist nicht lesbar');
      });
    return secret.value;
  }
}
