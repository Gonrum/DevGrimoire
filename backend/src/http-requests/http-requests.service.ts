import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { RequestCollection, RequestCollectionDocument } from './schemas/request-collection.schema';
import {
  SavedRequest, SavedRequestDocument,
  HttpRequestMethod, RequestAuthType, RequestBodyMode,
} from './schemas/saved-request.schema';
import { RequestHistoryEntry, RequestHistoryDocument } from './schemas/request-history.schema';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { CreateRequestDto } from './dto/create-request.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { SecretsService } from '../secrets/secrets.service';
import { EnvironmentsService } from '../environments/environments.service';
import { projectIdFilter } from '../common/project-id-filter';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { parseCurl } from './curl-parser';
import { isRecord, errorMessage } from '../common/narrow';
import {
  AUTH_TYPES, BODY_MODES, HTTP_METHODS,
  ParsedCurlRequest, RequestAuth, RequestBody, RequestDefinition,
} from './http-requests.types';
import { SendRequestDto } from './dto/send-request.dto';
import { buildResolutionContext, resolveRequest, maskSecrets } from './template-resolver';

const HISTORY_TTL_DAYS = 30;
const MAX_RESPONSE_BODY = 1_000_000; // 1 MB, wie in der Spec

export interface SendResult {
  historyId: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  durationMs: number;
  responseHeaders: { name: string; value: string }[];
  body: string;        // live, UNMASKIERT — an den Absender
  truncated: boolean;
  bodySize: number;
  contentType?: string;
  error?: string;
  unresolvedVariables: string[];
}

interface PreparedRequest {
  method: string;
  target: URL;
  headers: Record<string, string>;
  bodyInit?: BodyInit;
  bodySnapshot: string;
  resolved: ReturnType<typeof resolveRequest>;
  secretValues: Set<string>;
  environmentName?: string;
  environmentOid?: Types.ObjectId;
}

/**
 * Verengt einen fremden String auf einen der erlaubten Werte. `find` liefert
 * `T | undefined`, der verengte Typ entsteht also aus der Laufzeitprüfung statt
 * aus einer Behauptung — dasselbe Muster wie `optionalEnum` in
 * `common/tool-args.ts`.
 *
 * Gebraucht wird das, weil hier zwei Schreibweisen derselben Werte
 * zusammenlaufen: die Mongoose-/DTO-Seite benutzt String-Enums
 * (`HttpRequestMethod.GET`), die Nest-freien Resolver-Typen String-Unions
 * (`'GET'`). TS lässt zwischen beiden keine Zuweisung zu — vorher stand
 * deshalb an jeder Grenze ein `as unknown as`.
 */
function pickAllowed<T extends string>(allowed: readonly T[], value: string, label: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new BadRequestException(`${label} "${value}" wird nicht unterstützt`);
  }
  return match;
}

/** Felder, die `updateRequest` aus dem DTO nach `$set` durchlässt. */
const UPDATABLE_REQUEST_FIELDS = [
  'name', 'description', 'order', 'method', 'url', 'queryParams', 'headers',
  'auth', 'body', 'timeoutMs', 'followRedirects',
] as const satisfies readonly (keyof UpdateRequestDto)[];

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"]/g, '').replace(/[/\\]/g, '_').trim();
  return cleaned.length ? cleaned.slice(0, 200) : 'download';
}

function deriveFilename(upstream: Response, base: { name?: string }): string {
  const cd = upstream.headers.get('content-disposition');
  const m = cd ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd) : null;
  let raw = base.name || 'download';
  if (m) { try { raw = decodeURIComponent(m[1]); } catch { raw = m[1]; } }
  return sanitizeFilename(raw);
}

@Injectable()
export class HttpRequestsService {
  protected readonly logger = new Logger(HttpRequestsService.name);

  constructor(
    @InjectModel(RequestCollection.name) protected readonly collectionModel: Model<RequestCollectionDocument>,
    @InjectModel(SavedRequest.name) protected readonly requestModel: Model<SavedRequestDocument>,
    @InjectModel(RequestHistoryEntry.name) protected readonly historyModel: Model<RequestHistoryDocument>,
    protected readonly secretsService: SecretsService,
    protected readonly environmentsService: EnvironmentsService,
  ) {}

  protected objectId(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid ${label}`);
    return new Types.ObjectId(id);
  }

  // ---- Collections --------------------------------------------------------
  async createCollection(dto: CreateCollectionDto): Promise<RequestCollectionDocument> {
    if (!dto.projectId) throw new BadRequestException('projectId is required');
    return this.collectionModel.create({
      projectId: this.objectId(dto.projectId, 'projectId'),
      name: dto.name,
      description: dto.description,
      order: dto.order ?? 0,
    });
  }

  async listCollections(projectId: string): Promise<RequestCollectionDocument[]> {
    return this.collectionModel
      .find({ projectId: projectIdFilter(projectId) })
      .sort({ order: 1, name: 1 })
      .exec();
  }

  async updateCollection(id: string, dto: UpdateCollectionDto): Promise<RequestCollectionDocument> {
    const doc = await this.collectionModel.findByIdAndUpdate(this.objectId(id), { $set: dto }, { new: true }).exec();
    if (!doc) throw new NotFoundException('Collection not found');
    return doc;
  }

  async deleteCollection(id: string): Promise<void> {
    const oid = this.objectId(id);
    const col = await this.collectionModel.findByIdAndDelete(oid).exec();
    if (!col) throw new NotFoundException('Collection not found');
    const reqIds = await this.requestModel.find({ collectionId: oid }).distinct('_id').exec();
    if (reqIds.length) {
      await this.historyModel.deleteMany({ requestId: { $in: reqIds } }).exec();
      await this.requestModel.deleteMany({ _id: { $in: reqIds } }).exec();
    }
  }

  // ---- Requests -----------------------------------------------------------
  async createRequest(dto: CreateRequestDto): Promise<SavedRequestDocument> {
    if (!dto.collectionId) throw new BadRequestException('collectionId is required');
    const col = await this.collectionModel.findById(this.objectId(dto.collectionId, 'collectionId')).exec();
    if (!col) throw new NotFoundException('Collection not found');
    return this.requestModel.create({
      projectId: col.projectId,
      collectionId: col._id,
      name: dto.name,
      description: dto.description,
      order: dto.order ?? 0,
      method: dto.method ?? HttpRequestMethod.GET,
      url: dto.url,
      queryParams: dto.queryParams ?? [],
      headers: dto.headers ?? [],
      auth: dto.auth ?? { type: RequestAuthType.NONE },
      body: dto.body ?? { mode: RequestBodyMode.NONE },
      timeoutMs: dto.timeoutMs ?? 30000,
      followRedirects: dto.followRedirects ?? false,
    });
  }

  async listRequests(filter: { collectionId?: string; projectId?: string }): Promise<SavedRequestDocument[]> {
    const q: Record<string, unknown> = {};
    if (filter.collectionId) q.collectionId = this.objectId(filter.collectionId, 'collectionId');
    if (filter.projectId) q.projectId = projectIdFilter(filter.projectId);
    if (!q.collectionId && !q.projectId) throw new BadRequestException('collectionId or projectId is required');
    return this.requestModel.find(q).sort({ order: 1, name: 1 }).exec();
  }

  async getRequest(id: string): Promise<SavedRequestDocument> {
    const doc = await this.requestModel.findById(this.objectId(id)).exec();
    if (!doc) throw new NotFoundException('Request not found');
    return doc;
  }

  async updateRequest(id: string, dto: UpdateRequestDto): Promise<SavedRequestDocument> {
    const $set: Record<string, unknown> = {};
    for (const key of UPDATABLE_REQUEST_FIELDS) {
      const value = dto[key];
      if (value !== undefined) $set[key] = value;
    }
    const doc = await this.requestModel.findByIdAndUpdate(this.objectId(id), { $set }, { new: true }).exec();
    if (!doc) throw new NotFoundException('Request not found');
    return doc;
  }

  async deleteRequest(id: string): Promise<void> {
    const oid = this.objectId(id);
    const doc = await this.requestModel.findByIdAndDelete(oid).exec();
    if (!doc) throw new NotFoundException('Request not found');
    await this.historyModel.deleteMany({ requestId: oid }).exec();
  }

  // ---- History ------------------------------------------------------------
  async listHistory(requestId: string, limit = 50, offset = 0): Promise<RequestHistoryDocument[]> {
    return this.historyModel
      .find({ requestId: this.objectId(requestId, 'requestId') })
      .sort({ sentAt: -1 })
      .skip(Math.max(0, offset))
      .limit(Math.max(1, Math.min(limit, 500)))
      .exec();
  }

  async getHistoryEntry(id: string): Promise<RequestHistoryDocument> {
    const doc = await this.historyModel.findById(this.objectId(id)).exec();
    if (!doc) throw new NotFoundException('History entry not found');
    return doc;
  }

  // ---- curl import --------------------------------------------------------
  parseCurl(curl: string): ParsedCurlRequest {
    return parseCurl(curl);
  }

  async importCurl(collectionId: string, curl: string, name?: string): Promise<SavedRequestDocument> {
    const parsed = parseCurl(curl);
    return this.createRequest({
      collectionId,
      name: name || `${parsed.method} ${parsed.url}`.slice(0, 120),
      // Parser-Union → Schema-Enum. Der Parser liefert nur bekannte Werte, die
      // Prüfung kostet also nichts — sie ersetzt aber drei `as unknown as`,
      // die jeden künftigen Parser-Wert ungeprüft ins Schema geschrieben hätten.
      method: pickAllowed(Object.values(HttpRequestMethod), parsed.method, 'HTTP-Methode'),
      url: parsed.url,
      queryParams: parsed.queryParams,
      headers: parsed.headers,
      auth: {
        type: pickAllowed(Object.values(RequestAuthType), parsed.auth.type, 'Auth-Typ'),
        username: parsed.auth.username,
        password: parsed.auth.password,
        token: parsed.auth.token,
      },
      body: {
        mode: pickAllowed(Object.values(RequestBodyMode), parsed.body.mode, 'Body-Modus'),
        raw: parsed.body.raw,
        contentType: parsed.body.contentType,
        formFields: parsed.body.formFields,
      },
      followRedirects: parsed.followRedirects,
    });
  }

  // ---- Send (Backend-Proxy) -----------------------------------------------

  // Gemeinsame Auflösung für send() und openStream() (Templating + Secrets +
  // ausgehender Request). Kein fetch, kein read.
  private async prepareOutgoing(base: SavedRequestDocument, opts: SendRequestDto): Promise<PreparedRequest> {
    // Editor-Stand (DTO, String-Enums) oder gespeicherter Request
    // (Mongoose-Subdokumente) → Nest-freie Resolver-Form. Die Enum-Werte werden
    // dabei geprüft statt behauptet; ein Dokument mit einer Methode/einem
    // Body-Modus, den das Schema nicht kennt, führt jetzt zu 400 statt zu einem
    // ausgehenden Request mit erfundener Methode.
    const authSource = opts.auth ?? base.auth;
    const bodySource = opts.body ?? base.body;
    const auth: RequestAuth | undefined = authSource
      ? {
          type: pickAllowed(AUTH_TYPES, authSource.type, 'Auth-Typ'),
          username: authSource.username,
          password: authSource.password,
          token: authSource.token,
        }
      : undefined;
    const body: RequestBody | undefined = bodySource
      ? {
          mode: pickAllowed(BODY_MODES, bodySource.mode, 'Body-Modus'),
          raw: bodySource.raw,
          contentType: bodySource.contentType,
          formFields: bodySource.formFields,
        }
      : undefined;
    const def: RequestDefinition = {
      method: pickAllowed(HTTP_METHODS, opts.method ?? base.method, 'HTTP-Methode'),
      url: opts.url ?? base.url,
      queryParams: opts.queryParams ?? base.queryParams,
      headers: opts.headers ?? base.headers,
      auth,
      body,
      timeoutMs: opts.timeoutMs ?? base.timeoutMs,
      followRedirects: opts.followRedirects ?? base.followRedirects,
    };

    const projectId = base.projectId.toString();
    const globalSecrets = await this.secretsService.getDecryptedForEnvironment({ projectId }, '');
    let variables: { key: string; value: string }[] = [];
    let envSecrets: { key: string; value: string }[] = [];
    let environmentName: string | undefined;
    let environmentOid: Types.ObjectId | undefined;
    if (opts.environmentId) {
      const env = await this.environmentsService.findById(opts.environmentId);
      const envProj = env.projectId?.toString();
      if (envProj && envProj !== projectId) {
        throw new BadRequestException('Environment gehört nicht zu diesem Projekt');
      }
      variables = (env.variables ?? []).map((v) => ({ key: v.key, value: v.value }));
      envSecrets = await this.secretsService.getDecryptedForEnvironment({ projectId }, opts.environmentId);
      environmentName = env.name;
      environmentOid = this.objectId(opts.environmentId, 'environmentId');
    }
    const ctx = buildResolutionContext({ variables, globalSecrets, envSecrets });
    const resolved = resolveRequest(def, ctx);

    const method = resolved.method;
    const isBodyless = method === 'GET' || method === 'HEAD';

    let target: URL;
    try { target = new URL(resolved.url); }
    catch { throw new BadRequestException(`Ungültige URL: ${resolved.url}`); }
    for (const q of resolved.queryParams ?? []) {
      if (q.enabled !== false && q.key) target.searchParams.append(q.key, q.value ?? '');
    }

    const headers: Record<string, string> = {};
    const hasHeader = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
    for (const h of resolved.headers ?? []) {
      if (h.enabled !== false && h.name) headers[h.name] = h.value ?? '';
    }
    if (resolved.auth && resolved.auth.type === 'basic') {
      const cred = Buffer.from(`${resolved.auth.username ?? ''}:${resolved.auth.password ?? ''}`).toString('base64');
      headers['Authorization'] = `Basic ${cred}`;
    } else if (resolved.auth && resolved.auth.type === 'bearer') {
      headers['Authorization'] = `Bearer ${resolved.auth.token ?? ''}`;
    }

    let bodyInit: BodyInit | undefined;
    let bodySnapshot = '';
    if (!isBodyless && resolved.body && resolved.body.mode !== 'none') {
      const b = resolved.body;
      const enabledFields = (b.formFields ?? []).filter((f) => f.enabled !== false && f.key);
      if (b.mode === 'raw') {
        bodyInit = b.raw ?? '';
        bodySnapshot = b.raw ?? '';
        if (b.contentType && !hasHeader('content-type')) headers['Content-Type'] = b.contentType;
      } else if (b.mode === 'form-urlencoded') {
        const usp = new URLSearchParams();
        for (const f of enabledFields) usp.append(f.key, f.value ?? '');
        bodyInit = usp.toString();
        bodySnapshot = enabledFields.map((f) => `${f.key}=${f.value ?? ''}`).join('&');
        if (!hasHeader('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (b.mode === 'multipart') {
        const fd = new FormData();
        for (const f of enabledFields) fd.append(f.key, f.value ?? '');
        bodyInit = fd;
        bodySnapshot = enabledFields.map((f) => `${f.key}=${f.value ?? ''}`).join('&');
      }
    }

    return { method, target, headers, bodyInit, bodySnapshot, resolved, secretValues: ctx.secretValues, environmentName, environmentOid };
  }

  async send(id: string, opts: SendRequestDto = {}): Promise<SendResult> {
    const base = await this.getRequest(id);
    const prep = await this.prepareOutgoing(base, opts);
    const { method, target, headers, bodyInit, bodySnapshot, resolved, secretValues, environmentName, environmentOid } = prep;

    const controller = new AbortController();
    const timeoutMs = Math.min(resolved.timeoutMs ?? 30000, 120000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const sentAt = new Date();
    const t0 = Date.now();

    let status: number | undefined;
    let statusText: string | undefined;
    const responseHeaders: { name: string; value: string }[] = [];
    let liveBody = '';
    let truncated = false;
    let bodySize = 0;
    let contentType: string | undefined;
    let error: string | undefined;
    let ok = false;

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: resolved.followRedirects ? 'follow' : 'manual',
      };
      if (bodyInit !== undefined) init.body = bodyInit;
      const res = await fetch(target.toString(), init);
      status = res.status;
      statusText = res.statusText;
      ok = res.ok;
      contentType = res.headers.get('content-type') ?? undefined;
      res.headers.forEach((value, name) => responseHeaders.push({ name, value }));
      const rawText = await res.text();
      bodySize = Buffer.byteLength(rawText);
      truncated = rawText.length > MAX_RESPONSE_BODY;
      liveBody = truncated ? rawText.slice(0, MAX_RESPONSE_BODY) : rawText;
    } catch (err: unknown) {
      // `name` wird über `isRecord` gelesen statt über `instanceof Error`: der
      // Abbruch von fetch() kommt als DOMException, und ob die in der
      // Node-Version im Prototypen von Error hängt, soll die Timeout-Meldung
      // nicht entscheiden.
      const name = isRecord(err) ? err.name : undefined;
      error = name === 'AbortError' ? `Timeout nach ${timeoutMs}ms` : (errorMessage(err) || 'Unbekannter Fehler');
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - t0;

    const rawQueryStr = (resolved.queryParams ?? [])
      .filter((q) => q.enabled !== false && q.key)
      .map((q) => `${q.key}=${q.value ?? ''}`)
      .join('&');
    const urlForSnapshot = rawQueryStr ? `${resolved.url}?${rawQueryStr}` : resolved.url;

    const historyDoc = await this.historyModel.create({
      requestId: base._id,
      collectionId: base.collectionId,
      projectId: base.projectId,
      sentAt,
      durationMs,
      ok,
      method,
      url: maskSecrets(urlForSnapshot, secretValues),
      requestHeaders: Object.entries(headers).map(([name, value]) => ({
        name,
        value: name.toLowerCase() === 'authorization' ? '***' : maskSecrets(value, secretValues),
      })),
      requestBody: maskSecrets(bodySnapshot, secretValues),
      environmentId: environmentOid,
      environmentName,
      status,
      statusText,
      responseHeaders: responseHeaders.map((h) => ({ name: h.name, value: maskSecrets(h.value, secretValues) })),
      bodyText: maskSecrets(liveBody, secretValues),
      truncated,
      bodySize,
      contentType,
      error,
      expiresAt: new Date(sentAt.getTime() + HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    return {
      historyId: historyDoc._id.toString(),
      ok,
      status,
      statusText,
      durationMs,
      responseHeaders,
      body: liveBody,
      truncated,
      bodySize,
      contentType,
      error,
      unresolvedVariables: resolved.unresolved,
    };
  }

  // Streaming-Pfad: löst den Request auf, macht fetch OHNE den Body zu lesen und
  // gibt die rohe Response zum Durchpipen zurück. Kein Cap, kein Timeout-Abort
  // (der Download darf beliebig lange laufen).
  async openStream(
    id: string,
    opts: { environmentId?: string } = {},
  ): Promise<{ upstream: Response; filename: string; environmentName?: string }> {
    const base = await this.getRequest(id);
    const prep = await this.prepareOutgoing(base, opts);
    const init: RequestInit = {
      method: prep.method,
      headers: prep.headers,
      redirect: prep.resolved.followRedirects ? 'follow' : 'manual',
    };
    if (prep.bodyInit !== undefined) init.body = prep.bodyInit;
    const upstream = await fetch(prep.target.toString(), init);
    return { upstream, filename: deriveFilename(upstream, base), environmentName: prep.environmentName };
  }

  // ---- Cascade cleanup ----------------------------------------------------
  @OnEvent(PROJECT_CHANGED)
  async handleCascade(event: ProjectChangeEvent): Promise<void> {
    if (event.action !== 'deleted' || event.entity !== 'project' || !event.entityId) return;
    if (!Types.ObjectId.isValid(event.entityId)) return;
    const pid = projectIdFilter(event.entityId);
    const reqIds = await this.requestModel.find({ projectId: pid }).distinct('_id').exec();
    if (reqIds.length) await this.historyModel.deleteMany({ requestId: { $in: reqIds } }).exec();
    await this.requestModel.deleteMany({ projectId: pid }).exec();
    await this.collectionModel.deleteMany({ projectId: pid }).exec();
  }
}
