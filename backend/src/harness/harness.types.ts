/**
 * Pure type + enum definitions for Harness definitions (M-51 / H1).
 *
 * Deliberately free of mongoose and @nestjs imports: the merge resolver
 * (`harness-resolve.ts`) consumes these and must stay unit-testable straight
 * out of dist/ without booting Nest or connecting to MongoDB.
 */

export const HARNESS_SCOPES = ['global', 'customer', 'project'] as const;
export type HarnessScope = (typeof HARNESS_SCOPES)[number];

/**
 * `prose` and `bootstrap` are the only kinds H1 processes. `block` (MCP
 * prompts, H2) and `constraint` (enforced gates, H3) are already part of the
 * enum so those phases add behaviour without a schema migration.
 */
export const HARNESS_SECTION_KINDS = ['prose', 'bootstrap', 'block', 'constraint'] as const;
export type HarnessSectionKind = (typeof HARNESS_SECTION_KINDS)[number];

export const HARNESS_MERGE_STRATEGIES = ['replace', 'append', 'prepend'] as const;
export type HarnessMergeStrategy = (typeof HARNESS_MERGE_STRATEGIES)[number];

/** kebab-case, used as the join key when merging levels. */
export const HARNESS_SECTION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface HarnessSectionInput {
  key: string;
  /**
   * Typed as a widened string on purpose: a section written by a newer
   * instance may carry a kind this build does not know yet, and the resolver
   * has to pass it through rather than drop it.
   */
  kind: HarnessSectionKind | string;
  /** Omitted or empty means: inherit the title from the level below. */
  title?: string;
  body: string;
  payload?: Record<string, unknown>;
  mergeStrategy: HarnessMergeStrategy;
  order?: number;
  enabled?: boolean;
}

export interface HarnessLevelInput {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  /** `false` skips the entire level — it contributes nothing and is not reported. */
  enabled?: boolean;
  sections: HarnessSectionInput[];
}

export interface ResolvedSectionOrigin {
  scope: HarnessScope;
  customerId?: string;
  mergeStrategy: HarnessMergeStrategy;
}

export interface ResolvedSection {
  key: string;
  kind: HarnessSectionKind | string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  order: number;
  /** Every level that contributed to this section, in merge order. */
  origin: ResolvedSectionOrigin[];
}

export interface ResolvedLevel {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
}

export interface SuppressedSection {
  key: string;
  /** The level that switched the section off. */
  scope: HarnessScope;
}

export interface ResolvedHarness {
  /** Sorted by `order` ascending, then `key` for stable ties. */
  sections: ResolvedSection[];
  /**
   * Sections a higher level tombstoned. Kept in the result so the UI can show
   * "switched off here" instead of silently omitting an inherited rule.
   */
  suppressed: SuppressedSection[];
  /** The levels actually processed, in merge order. */
  resolvedFrom: ResolvedLevel[];
  /** Rendered view — what an agent drops into its context. */
  markdown: string;
}
