/**
 * Harness merge resolver (T-437, M-51 / H1).
 *
 * Pure function by design — no mongoose, no @nestjs imports. Loading the
 * levels from MongoDB (including which customer harnesses a project inherits
 * and in what order) is the service's job; this file only decides what the
 * merged result looks like, which keeps it unit-testable against dist/.
 *
 * See `npm run check:harness-resolve`.
 */
import {
  HarnessLevelInput,
  HarnessSectionInput,
  ResolvedHarness,
  ResolvedLevel,
  ResolvedSection,
  ResolvedSectionOrigin,
  SuppressedSection,
} from './harness.types';

/**
 * Merges harness levels in the order given — the caller is responsible for
 * handing them over as `global → customer(s) → project`.
 *
 * Sections are joined on `key`. Which of the two bodies survives is decided
 * by the *incoming* section's `mergeStrategy`, so a project can extend an
 * inherited convention instead of only being able to replace it.
 */
export function resolveHarness(levels: HarnessLevelInput[]): ResolvedHarness {
  const merged = new Map<string, ResolvedSection>();
  const suppressed = new Map<string, SuppressedSection>();
  const resolvedFrom: ResolvedLevel[] = [];

  for (const level of levels) {
    // A level switched off contributes nothing and is not reported as part of
    // the chain — otherwise the UI would claim an inheritance that never ran.
    if (level.enabled === false) continue;

    resolvedFrom.push({
      scope: level.scope,
      projectId: level.projectId,
      customerId: level.customerId,
    });

    for (const section of dedupeByKey(level.sections)) {
      if (section.enabled === false) {
        // Tombstone: a lower level can switch off an inherited rule without
        // anyone having to edit the level that defined it.
        merged.delete(section.key);
        suppressed.set(section.key, { key: section.key, scope: level.scope });
        continue;
      }

      suppressed.delete(section.key);
      merged.set(section.key, mergeSection(merged.get(section.key), section, level));
    }
  }

  const sections = [...merged.values()].sort(
    (a, b) => a.order - b.order || a.key.localeCompare(b.key),
  );

  return {
    sections,
    suppressed: [...suppressed.values()],
    resolvedFrom,
    markdown: renderMarkdown(sections),
  };
}

/**
 * Within a single level a key can only appear once — the schema enforces it.
 * Should a document slip through anyway (hand-edited, replicated from an older
 * build), the last entry wins instead of the section merging with itself,
 * which would silently duplicate its body under `append`.
 */
function dedupeByKey(sections: HarnessSectionInput[]): HarnessSectionInput[] {
  const byKey = new Map<string, HarnessSectionInput>();
  for (const section of sections) {
    byKey.set(section.key, section);
  }
  return [...byKey.values()];
}

function mergeSection(
  previous: ResolvedSection | undefined,
  section: HarnessSectionInput,
  level: HarnessLevelInput,
): ResolvedSection {
  const origin: ResolvedSectionOrigin[] = [
    ...(previous?.origin ?? []),
    {
      scope: level.scope,
      customerId: level.customerId,
      mergeStrategy: section.mergeStrategy,
    },
  ];

  return {
    key: section.key,
    kind: section.kind,
    // Empty title/payload on the higher level means "not specified here",
    // so the inherited value stays rather than being blanked out.
    title: section.title || previous?.title || '',
    body: previous ? combineBodies(previous.body, section.body, section.mergeStrategy) : section.body,
    payload: section.payload ?? previous?.payload,
    order: section.order ?? previous?.order ?? 0,
    origin,
  };
}

function combineBodies(
  accumulated: string,
  incoming: string,
  strategy: HarnessSectionInput['mergeStrategy'],
): string {
  switch (strategy) {
    case 'append':
      return joinBodies(accumulated, incoming);
    case 'prepend':
      return joinBodies(incoming, accumulated);
    case 'replace':
    default:
      return incoming;
  }
}

function joinBodies(first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  return `${first.trimEnd()}\n\n${second.trimStart()}`;
}

function renderMarkdown(sections: ResolvedSection[]): string {
  return sections
    .map((section) =>
      [section.title ? `## ${section.title}` : '', section.body].filter(Boolean).join('\n\n'),
    )
    .filter(Boolean)
    .join('\n\n');
}
