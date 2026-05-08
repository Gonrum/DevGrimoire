/**
 * Data classification for entities that may carry sensitive content.
 *
 * Drives RAG-indexing rules (see knowledge entry T-219): entries marked
 * `confidential`, `personal`, or `secret` are NEVER ingested into the vector
 * index, even if they belong to one of the indexable entity types. Public and
 * internal entries are indexed normally.
 */
export const Sensitivity = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  PERSONAL: 'personal',
  SECRET: 'secret',
} as const;

export type SensitivityLevel = (typeof Sensitivity)[keyof typeof Sensitivity];

export const ALL_SENSITIVITY_LEVELS: SensitivityLevel[] = Object.values(Sensitivity) as SensitivityLevel[];

/**
 * Levels that bar an entity from RAG ingestion. Secrets are doubly-protected
 * here even though their entity type isn't currently in INDEXABLE_ENTITIES —
 * keeps the rule honest if a future commit accidentally adds it.
 */
const RAG_EXCLUDED_LEVELS: ReadonlySet<SensitivityLevel> = new Set([
  Sensitivity.CONFIDENTIAL,
  Sensitivity.PERSONAL,
  Sensitivity.SECRET,
]);

export function isExcludedFromRag(level: SensitivityLevel | undefined | null): boolean {
  if (!level) return false;
  return RAG_EXCLUDED_LEVELS.has(level);
}
