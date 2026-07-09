import { ResearchArtifactService } from './research-artifact.service';
import { ResearchGuardrails, ResearchTopicDocument } from './schemas/research-topic.schema';
import { RunStep } from './schemas/research-run.schema';
import { RagSearchHit } from '../rag/rag.service';
import { SearchResult } from '../web-search/providers/search-provider.interface';

/**
 * OpenAI function-calling format — the exact shape `getToolsForLlm()` in
 * `chat/chat-tools.ts` produces (`OpenAiTool`) and that the balancer's
 * `LlmClient.chatStreamOpenAiTools`/`chatStreamAnthropicTools` (the latter
 * translating OpenAI tool defs to Anthropic `tool_use` blocks) already know
 * how to consume. Kept as an independent type here (rather than importing
 * `OpenAiTool`) so this module has zero runtime dependency on the chat
 * module — the research-agent's tool loop is a separate LLM consumer that
 * happens to share the same wire format.
 */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Scope tuple `RagService.searchScopes` expects — see `deriveScope` below. */
export interface RagScope {
  projectIds: string[];
  customerIds: string[];
  includeGlobal: boolean;
}

/**
 * Everything the agent tool loop needs, injected rather than resolved via
 * Nest DI — keeps `buildResearchTools` a pure function of its context and
 * therefore unit-testable without a Mongo connection, HTTP client, or
 * module bootstrap (see `scripts/research-agent-tools-check.cjs`). The
 * runner that actually drives a research run (background job) is
 * responsible for adapting the real `RagService`/`WebSearchService`/
 * `ReadabilityService`/`ResearchArtifactService` instances into this shape.
 */
export interface ResearchToolContext {
  topic: ResearchTopicDocument;
  rag: {
    searchScopes: (query: string, scope: RagScope, limit?: number) => Promise<RagSearchHit[]>;
  };
  web: {
    search: (query: string) => Promise<SearchResult[]>;
    fetch: (url: string) => Promise<{ title: string; text: string }>;
  };
  artifacts: Pick<ResearchArtifactService, 'listByTopic' | 'getBySlug' | 'write' | 'remove'>;
  /** Mutable guardrail counters — `dispatch` increments these in place. */
  counters: { webSearches: number; webFetches: number };
  guardrails: ResearchGuardrails;
  onStep: (step: RunStep) => Promise<void>;
}

// Cost guards: rag_search must never be able to pull an unbounded number of
// hits into the agent's context window (and from there into every
// subsequent LLM turn's prompt).
const RAG_SEARCH_DEFAULT_LIMIT = 6;
const RAG_SEARCH_MAX_LIMIT = 8;

// Compact-result and audit-trail truncation lengths. These are deliberately
// small — results are meant to read as "title + snippet + url", not raw
// document dumps; the full artifact is always available again via
// `artifact_read` (or, for the human, the artifact itself).
const SNIPPET_CHARS = 400;
const ARTIFACT_PREVIEW_CHARS = 8000;
const STEP_SUMMARY_CHARS = 400;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [gekürzt, ${text.length} Zeichen gesamt]`;
}

function toIdStrings(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id));
}

/**
 * Derives the `RagService.searchScopes` scope tuple directly from the
 * topic's own `ResearchScope` (projectIds/customerIds as ObjectIds →
 * strings, includeGlobal passed through). This is a placeholder for a
 * shared `scopeFrom(topic)` helper planned for a later task once the
 * research-topic service's "mode: all" resolution (turning "all projects"
 * into a concrete id list per the caller's access) lands; until then this
 * inline mapping is intentionally the simplest thing that satisfies the
 * guarded-dispatch contract without pulling in that service.
 */
function deriveScope(topic: ResearchTopicDocument): RagScope {
  const scope = topic.scope;
  return {
    projectIds: toIdStrings(scope?.projectIds),
    customerIds: toIdStrings(scope?.customerIds),
    includeGlobal: scope?.includeGlobal !== false,
  };
}

function topicId(topic: ResearchTopicDocument): string {
  return topic._id.toString();
}

function requireString(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Parameter "${key}" ist erforderlich`);
  }
  return value.trim();
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(args: unknown, key: string): string[] | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function ragSearchDef(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'rag_search',
      description:
        'Bedeutungsbasierte Suche über das Projekt-/Kunden-Wissen (Knowledge, Research, Manual, Changelog, Todos, Snippets, Attachments) im Scope dieses Recherche-Themas. Für internes Wissen immer dieser Suche gegenüber Web-Suche den Vorzug geben.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
          limit: {
            type: 'number',
            description: `Max. Anzahl Treffer (1-${RAG_SEARCH_MAX_LIMIT}, Default ${RAG_SEARCH_DEFAULT_LIMIT})`,
          },
        },
        required: ['query'],
      },
    },
  };
}

function webSearchDef(guardrails: ResearchGuardrails): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'web_search',
      description: `Sucht im öffentlichen Web. Nur lesend. Begrenzt auf maximal ${guardrails.maxWebSearches} Aufrufe pro Recherche-Lauf — danach liefert das Tool nur noch einen Limit-Hinweis. Für internes Wissen lieber rag_search verwenden.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        },
        required: ['query'],
      },
    },
  };
}

function webFetchDef(guardrails: ResearchGuardrails): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: `Lädt eine öffentliche URL und extrahiert den Artikeltext. Begrenzt auf maximal ${guardrails.maxWebFetches} Aufrufe pro Recherche-Lauf — danach liefert das Tool nur noch einen Limit-Hinweis.`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Öffentliche http(s)-URL' },
        },
        required: ['url'],
      },
    },
  };
}

function artifactListDef(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'artifact_list',
      description: 'Listet die vorhandenen Artefakte dieses Recherche-Themas (Slug, Titel, Summary, Version).',
      parameters: { type: 'object', properties: {} },
    },
  };
}

function artifactReadDef(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'artifact_read',
      description: 'Lädt ein vorhandenes Artefakt dieses Themas per Slug, inklusive Volltext — z.B. um es vor einem Update zu prüfen.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Slug des Artefakts (siehe artifact_list)' },
        },
        required: ['slug'],
      },
    },
  };
}

function artifactWriteDef(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'artifact_write',
      description:
        'Legt ein Artefakt dieses Themas an oder aktualisiert es (Upsert per Slug). Ein bestehendes Artefakt mit demselben Slug wird versioniert überschrieben, nicht dupliziert.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Eindeutiger Slug innerhalb des Themas (wird normalisiert: lowercase, a-z0-9, "-")' },
          title: { type: 'string' },
          content: { type: 'string', description: 'Vollständiger Artefakt-Inhalt (Markdown)' },
          summary: { type: 'string', description: 'Kurze Zusammenfassung (optional)' },
          tags: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' }, description: 'Quell-URLs / Referenzen' },
          changeNote: { type: 'string', description: 'Kurze Notiz, was sich gegenüber der Vorversion geändert hat' },
        },
        required: ['slug', 'title', 'content'],
      },
    },
  };
}

function artifactDeleteDef(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'artifact_delete',
      description:
        'Löscht ein Artefakt dieses Themas inklusive seiner Versions-Historie. Sollte selten benutzt werden — nur wenn ein Artefakt fehlerhaft oder obsolet ist, nicht um Platz zu sparen.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
  };
}

/**
 * Builds the tool defs + guarded dispatcher for one research-agent run.
 *
 * `defs` conditionally omits `web_search`/`web_fetch` when the topic has web
 * search disabled — the run's LLM never even sees those tools offered. But
 * `dispatch` does not merely trust that: it re-checks the same flag before
 * running either tool, and independently checks + increments the mutable
 * `ctx.counters` against `ctx.guardrails` BEFORE calling the underlying
 * service, so a runaway loop (or a model that "forgets" it already used up
 * its budget) cannot exceed `maxWebSearches`/`maxWebFetches`.
 *
 * Every dispatch — success, guardrail-refusal, or thrown error — is
 * recorded as a `tool_call` + `tool_result` pair via `ctx.onStep`, so the
 * run's persisted audit trail (`ResearchRun.steps`) always has a result for
 * every call, not just the successful ones.
 */
export function buildResearchTools(ctx: ResearchToolContext): {
  defs: ToolDef[];
  dispatch: (name: string, args: unknown) => Promise<string>;
} {
  const webEnabled = ctx.topic?.webSearch?.enabled === true;

  const defs: ToolDef[] = [ragSearchDef()];
  if (webEnabled) {
    defs.push(webSearchDef(ctx.guardrails), webFetchDef(ctx.guardrails));
  }
  defs.push(artifactListDef(), artifactReadDef(), artifactWriteDef(), artifactDeleteDef());

  async function execRagSearch(args: unknown): Promise<string> {
    const query = requireString(args, 'query');
    const requested = (args as { limit?: unknown })?.limit;
    const requestedLimit = typeof requested === 'number' && Number.isFinite(requested) ? requested : RAG_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(Math.trunc(requestedLimit), RAG_SEARCH_MAX_LIMIT));

    const hits = await ctx.rag.searchScopes(query, deriveScope(ctx.topic), limit);
    return JSON.stringify(
      hits.map((h) => ({
        title: h.title,
        entity: h.entity,
        snippet: truncate(h.content, SNIPPET_CHARS),
        score: Math.round(h.score * 1000) / 1000,
      })),
    );
  }

  async function execWebSearch(args: unknown): Promise<string> {
    if (!webEnabled) return 'Web-Suche ist für dieses Recherche-Thema deaktiviert.';
    if (ctx.counters.webSearches >= ctx.guardrails.maxWebSearches) {
      return `Limit erreicht: maximal ${ctx.guardrails.maxWebSearches} Web-Suchen pro Recherche-Lauf sind bereits verbraucht.`;
    }
    const query = requireString(args, 'query');
    ctx.counters.webSearches += 1;
    const results = await ctx.web.search(query);
    return JSON.stringify(
      results.map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.snippet ?? '', SNIPPET_CHARS) })),
    );
  }

  async function execWebFetch(args: unknown): Promise<string> {
    if (!webEnabled) return 'Web-Suche ist für dieses Recherche-Thema deaktiviert.';
    if (ctx.counters.webFetches >= ctx.guardrails.maxWebFetches) {
      return `Limit erreicht: maximal ${ctx.guardrails.maxWebFetches} Web-Abrufe pro Recherche-Lauf sind bereits verbraucht.`;
    }
    const url = requireString(args, 'url');
    ctx.counters.webFetches += 1;
    const page = await ctx.web.fetch(url);
    return JSON.stringify({ title: page.title, url, snippet: truncate(page.text ?? '', SNIPPET_CHARS) });
  }

  async function execArtifactList(): Promise<string> {
    const list = await ctx.artifacts.listByTopic(topicId(ctx.topic));
    return JSON.stringify(list);
  }

  async function execArtifactRead(args: unknown): Promise<string> {
    const slug = requireString(args, 'slug');
    const artifact = await ctx.artifacts.getBySlug(topicId(ctx.topic), slug);
    if (!artifact) return JSON.stringify({ found: false, slug });
    return JSON.stringify({
      found: true,
      slug: artifact.slug,
      title: artifact.title,
      version: artifact.version,
      summary: artifact.summary,
      tags: artifact.tags,
      sources: artifact.sources,
      content: truncate(artifact.content, ARTIFACT_PREVIEW_CHARS),
    });
  }

  async function execArtifactWrite(args: unknown): Promise<string> {
    const slug = requireString(args, 'slug');
    const title = requireString(args, 'title');
    const content = requireString(args, 'content');
    const artifact = await ctx.artifacts.write(
      topicId(ctx.topic),
      {
        slug,
        title,
        content,
        summary: optionalString(args, 'summary'),
        tags: optionalStringArray(args, 'tags'),
        sources: optionalStringArray(args, 'sources'),
        changeNote: optionalString(args, 'changeNote'),
      },
      ctx.topic.scope,
    );
    // ResearchArtifactService.write always creates at version=1 and always
    // increments on update — so version===1 unambiguously means "created".
    const action: 'created' | 'updated' = artifact.version === 1 ? 'created' : 'updated';
    return JSON.stringify({ slug: artifact.slug, version: artifact.version, action });
  }

  async function execArtifactDelete(args: unknown): Promise<string> {
    const slug = requireString(args, 'slug');
    await ctx.artifacts.remove(topicId(ctx.topic), slug);
    return JSON.stringify({ slug, action: 'deleted' });
  }

  async function execute(name: string, args: unknown): Promise<string> {
    switch (name) {
      case 'rag_search':
        return execRagSearch(args);
      case 'web_search':
        return execWebSearch(args);
      case 'web_fetch':
        return execWebFetch(args);
      case 'artifact_list':
        return execArtifactList();
      case 'artifact_read':
        return execArtifactRead(args);
      case 'artifact_write':
        return execArtifactWrite(args);
      case 'artifact_delete':
        return execArtifactDelete(args);
      default:
        throw new Error(`Unbekanntes Tool: ${name}`);
    }
  }

  async function dispatch(name: string, args: unknown): Promise<string> {
    const argsSummary = truncate(JSON.stringify(args ?? {}), STEP_SUMMARY_CHARS);
    await ctx.onStep({ type: 'tool_call', tool: name, argsSummary, ts: new Date() });

    let resultText: string;
    try {
      resultText = await execute(name, args);
    } catch (err) {
      resultText = `Fehler: ${err instanceof Error ? err.message : String(err)}`;
      await ctx.onStep({ type: 'tool_result', tool: name, resultSummary: truncate(resultText, STEP_SUMMARY_CHARS), ts: new Date() });
      return resultText;
    }

    await ctx.onStep({ type: 'tool_result', tool: name, resultSummary: truncate(resultText, STEP_SUMMARY_CHARS), ts: new Date() });
    return resultText;
  }

  return { defs, dispatch };
}
