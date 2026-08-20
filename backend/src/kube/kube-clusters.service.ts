import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { KubeCluster, KubeClusterDocument, KubePrometheusConfig } from './schemas/kube-cluster.schema';
import { Secret, SecretDocument } from '../secrets/schemas/secret.schema';
import { SecretsService } from '../secrets/secrets.service';
import { parseKubeconfig } from './kubeconfig-parser';
import { isDuplicateKeyError } from '../common/narrow';
import { CreateKubeClusterDto, KubePrometheusDto } from './dto/create-kube-cluster.dto';
import { UpdateKubeClusterDto } from './dto/update-kube-cluster.dto';

@Injectable()
export class KubeClustersService {
  constructor(
    @InjectModel(KubeCluster.name) private readonly clusterModel: Model<KubeClusterDocument>,
    @InjectModel(Secret.name) private readonly secretModel: Model<SecretDocument>,
    private readonly secretsService: SecretsService,
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

  async create(dto: CreateKubeClusterDto): Promise<KubeClusterDocument> {
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

    const _id = new Types.ObjectId();
    const secret = await this.secretsService.create({
      projectId: dto.projectId,
      customerId: dto.customerId,
      key: `kubeconfig-${dto.slug}`,
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
    const doc = await this.findById(id);
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

    await doc.save();
    return doc;
  }

  async delete(id: string): Promise<void> {
    const _id = this.toObjectId(id, 'id');
    await this.secretModel.deleteMany({ ownedByKubeClusterId: _id }).exec();
    await this.clusterModel.deleteOne({ _id }).exec();
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
