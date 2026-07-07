import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LlmEndpoint, LlmEndpointDocument } from './schemas/llm-endpoint.schema';
import { EncryptionService } from '../common/encryption.service';
import {
  LlmProviderKind, LlmPurpose, PoolEndpoint, LLM_PROVIDER_KINDS, LLM_PURPOSES,
} from './balancer.types';

export interface LlmEndpointInput {
  label: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  /** undefined → keep existing; '' → clear; value → encrypt+store. */
  apiKey?: string;
  purposes: LlmPurpose[];
  visionCapable?: boolean;
  concurrency?: number;
  priority?: number;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface LlmEndpointPublic {
  id: string;
  label: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  purposes: LlmPurpose[];
  visionCapable: boolean;
  concurrency: number;
  priority: number;
  timeoutMs: number;
  enabled: boolean;
}

/** Pure merge helper (exported for the .cjs unit check). */
export function resolveApiKeyEnc(
  enc: { isEnabled(): boolean; encrypt(s: string): string },
  prevEnc: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming === undefined) return prevEnc;
  if (incoming === '') return undefined;
  if (!enc.isEnabled()) {
    throw new Error('Cannot store API key: SECRETS_ENCRYPTION_KEY is not configured.');
  }
  return enc.encrypt(incoming);
}

/** Parse model ids from an upstream models-listing response, per provider. */
function extractModelIds(provider: LlmProviderKind, json: unknown): string[] {
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return [];
  if (provider === 'ollama') {
    // Ollama /api/tags → { models: [{ name: "llama3:8b" }] }
    const arr = Array.isArray(o.models) ? o.models : [];
    return arr.map((m) => (m as Record<string, unknown>)?.name).filter((n): n is string => typeof n === 'string');
  }
  // OpenAI-compatible / OpenAI / Anthropic /v1/models → { data: [{ id: "..." }] }
  const arr = Array.isArray(o.data) ? o.data : [];
  return arr.map((m) => (m as Record<string, unknown>)?.id).filter((n): n is string => typeof n === 'string');
}

function clampConcurrency(n: number | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1;
  return Math.min(16, Math.max(1, v || 1));
}

@Injectable()
export class LlmEndpointsService {
  constructor(
    @InjectModel(LlmEndpoint.name) private readonly model: Model<LlmEndpointDocument>,
    private readonly encryption: EncryptionService,
  ) {}

  toPublic(doc: LlmEndpointDocument): LlmEndpointPublic {
    return {
      id: String(doc._id),
      label: doc.label,
      provider: doc.provider as LlmProviderKind,
      baseUrl: doc.baseUrl,
      model: doc.model,
      hasApiKey: !!doc.apiKeyEnc && doc.apiKeyEnc.length > 0,
      purposes: (doc.purposes as LlmPurpose[]) ?? [],
      visionCapable: !!doc.visionCapable,
      concurrency: doc.concurrency,
      priority: doc.priority,
      timeoutMs: doc.timeoutMs,
      enabled: doc.enabled,
    };
  }

  private validate(dto: LlmEndpointInput): void {
    if (!LLM_PROVIDER_KINDS.includes(dto.provider)) throw new Error(`Invalid provider: ${dto.provider}`);
    if (!dto.label?.trim()) throw new Error('label is required');
    if (!dto.baseUrl?.trim()) throw new Error('baseUrl is required');
    if (!dto.model?.trim()) throw new Error('model is required');
    if (!Array.isArray(dto.purposes) || dto.purposes.some((p) => !LLM_PURPOSES.includes(p))) {
      throw new Error('purposes must be a subset of chat|embedding|workflow');
    }
  }

  async list(): Promise<LlmEndpointPublic[]> {
    const docs = await this.model.find().sort({ priority: 1, label: 1 }).exec();
    return docs.map((d) => this.toPublic(d));
  }

  async create(dto: LlmEndpointInput): Promise<LlmEndpointPublic> {
    this.validate(dto);
    const apiKeyEnc = resolveApiKeyEnc(this.encryption, undefined, dto.apiKey);
    const doc = await this.model.create({
      label: dto.label, provider: dto.provider, baseUrl: dto.baseUrl.replace(/\/$/, ''),
      model: dto.model, apiKeyEnc, purposes: dto.purposes, visionCapable: !!dto.visionCapable,
      concurrency: clampConcurrency(dto.concurrency), priority: dto.priority ?? 100,
      timeoutMs: dto.timeoutMs ?? 0, enabled: dto.enabled ?? true,
    });
    return this.toPublic(doc);
  }

  async update(id: string, dto: LlmEndpointInput): Promise<LlmEndpointPublic> {
    this.validate(dto);
    const existing = await this.model.findById(id).exec();
    if (!existing) throw new NotFoundException('endpoint_not_found');
    const apiKeyEnc = resolveApiKeyEnc(this.encryption, existing.apiKeyEnc, dto.apiKey);
    existing.set({
      label: dto.label, provider: dto.provider, baseUrl: dto.baseUrl.replace(/\/$/, ''),
      model: dto.model, apiKeyEnc, purposes: dto.purposes, visionCapable: !!dto.visionCapable,
      concurrency: clampConcurrency(dto.concurrency), priority: dto.priority ?? existing.priority,
      timeoutMs: dto.timeoutMs ?? existing.timeoutMs, enabled: dto.enabled ?? existing.enabled,
    });
    // Mongoose can't unset via set(undefined); explicitly clear when cleared.
    if (apiKeyEnc === undefined) existing.apiKeyEnc = undefined;
    await existing.save();
    return this.toPublic(existing);
  }

  async remove(id: string): Promise<void> {
    const res = await this.model.findByIdAndDelete(id).exec();
    if (!res) throw new NotFoundException('endpoint_not_found');
  }

  async listForPool(purpose: LlmPurpose, filter?: { requireVision?: boolean }): Promise<PoolEndpoint[]> {
    const docs = await this.model
      .find({ enabled: true, purposes: purpose })
      .sort({ priority: 1, _id: 1 })
      .exec();
    return docs
      .filter((d) => !filter?.requireVision || d.visionCapable)
      .map((d) => ({
        id: String(d._id),
        provider: d.provider as LlmProviderKind,
        baseUrl: d.baseUrl,
        model: d.model,
        concurrency: clampConcurrency(d.concurrency),
        timeoutMs: d.timeoutMs,
        visionCapable: !!d.visionCapable,
      }));
  }

  async getDecryptedApiKey(id: string): Promise<string | null> {
    const doc = await this.model.findById(id).exec();
    if (!doc?.apiKeyEnc) return null;
    try {
      return this.encryption.decrypt(doc.apiKeyEnc);
    } catch {
      return null;
    }
  }

  async count(): Promise<number> {
    return this.model.countDocuments().exec();
  }

  async existsByIdentity(provider: string, baseUrl: string, model: string): Promise<boolean> {
    const normUrl = baseUrl.replace(/\/$/, '');
    const doc = await this.model.findOne({ provider, baseUrl: normUrl, model }).exec();
    return !!doc;
  }

  /**
   * Connectivity probe + model listing — no inference, so it never touches the
   * queue. Works on an unsaved endpoint (add-form) via provider/baseUrl/apiKey.
   * `apiKey`: a non-empty value is used as-is; `''` means "no key"; `undefined`
   * with an `id` falls back to that endpoint's stored key.
   */
  async probeModels(input: {
    provider: LlmProviderKind; baseUrl: string; apiKey?: string; id?: string;
  }): Promise<{ ok: boolean; latencyMs?: number; error?: string; models?: string[] }> {
    const provider = input.provider;
    if (!LLM_PROVIDER_KINDS.includes(provider)) return { ok: false, error: `invalid provider: ${provider}` };
    const baseUrl = (input.baseUrl || '').trim().replace(/\/$/, '');
    if (!baseUrl) return { ok: false, error: 'baseUrl required' };

    let apiKey: string | null = null;
    if (input.apiKey !== undefined && input.apiKey !== '') apiKey = input.apiKey;
    else if (input.apiKey === undefined && input.id) apiKey = await this.getDecryptedApiKey(input.id);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let url: string;
    if (provider === 'anthropic') {
      url = `${baseUrl}/v1/models`;
      if (apiKey) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
    } else if (provider === 'ollama') {
      url = `${baseUrl}/api/tags`;
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    } else {
      url = `${baseUrl}/v1/models`;
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    }

    const start = Date.now();
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
      const latencyMs = Date.now() - start;
      if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
      const json = (await res.json().catch(() => null)) as unknown;
      const models = extractModelIds(provider, json);
      return { ok: true, latencyMs, models };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }

  /** Connectivity probe for a saved endpoint (reuses probeModels). */
  async testConnection(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string; models?: string[] }> {
    const doc = await this.model.findById(id).exec();
    if (!doc) return { ok: false, error: 'endpoint_not_found' };
    return this.probeModels({ provider: doc.provider as LlmProviderKind, baseUrl: doc.baseUrl, id });
  }
}
