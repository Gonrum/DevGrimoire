/**
 * Migrationsplanung: Soul + `project.instructions` + `agent_instructions`
 * → Harness-Sections (T-442, M-51/H1).
 *
 * Reine Funktion, wie schon der Merge-Resolver — kein mongoose, kein @nestjs.
 * Die Datenbank-Seite (lesen, schreiben, Zusammenfassung ausgeben) steckt in
 * `scripts/harness-migrate.cjs`.
 *
 * Der Grund für die Trennung ist die zentrale Anforderung des Todos:
 * **Idempotenz**. Ob ein zweiter Lauf denselben Zustand ergibt, lässt sich so
 * ohne Datenbank prüfen — man füttert den Planer mit dem Ergebnis des ersten
 * Laufs und erwartet einen leeren Plan.
 */
import {
  HARNESS_KEY_INSTRUCTIONS,
  HARNESS_KEY_TOOL_USAGE,
  HARNESS_SOUL_SECTIONS,
  HarnessScope,
} from './harness.types';

export interface SoulSource {
  projectId?: string;
  customerId?: string;
  /** Die sieben Soul-Felder; alles andere wird ignoriert. */
  fields: Record<string, unknown>;
}

export interface ProjectSource {
  id: string;
  instructions?: string;
}

/** Was auf einer Ebene bereits existiert — Grundlage der Idempotenz. */
export interface ExistingLevel {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  sectionKeys: string[];
}

export interface PlannedSection {
  key: string;
  kind: 'prose';
  title: string;
  body: string;
  mergeStrategy: 'replace';
  order: number;
}

export interface PlannedLevel {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  sections: PlannedSection[];
}

export interface SkippedSection {
  scope: HarnessScope;
  owner?: string;
  key: string;
  reason: 'empty' | 'exists';
}

export interface MigrationPlan {
  levels: PlannedLevel[];
  skipped: SkippedSection[];
}

export interface MigrationInput {
  souls: SoulSource[];
  projects: ProjectSource[];
  /** Wert des Settings-Schlüssels `agent_instructions`. */
  agentInstructions?: string;
  existing: ExistingLevel[];
}

/**
 * Erzeugt den Plan: welche Sections auf welchen Ebenen geschrieben werden.
 *
 * Was **nicht** geplant wird:
 * - leere Quellfelder (ein Soul mit leerem `boundaries` erzeugt keine leere
 *   Section — sonst überschriebe eine leere Projektebene später eine gefüllte
 *   Firmenebene, weil `replace` auch mit leerem Body greift)
 * - Sections, deren Key auf der Ebene bereits existiert. Das ist die
 *   Idempotenz-Regel und zugleich der Schutz aus dem Edge Case: eine von Hand
 *   angelegte Section wird nicht überschrieben.
 *
 * Ebenen ohne verbleibende Sections tauchen im Plan gar nicht erst auf — ein
 * komplett leerer Soul erzeugt also keinen Harness.
 */
export function planHarnessMigration(input: MigrationInput): MigrationPlan {
  const skipped: SkippedSection[] = [];
  const levels: PlannedLevel[] = [];

  const existingKeys = (scope: HarnessScope, owner?: string): Set<string> => {
    const match = input.existing.find(
      (level) =>
        level.scope === scope &&
        (scope === 'global' ||
          (scope === 'project' ? level.projectId : level.customerId) === owner),
    );
    return new Set(match?.sectionKeys ?? []);
  };

  const keep = (
    scope: HarnessScope,
    owner: string | undefined,
    taken: Set<string>,
    key: string,
    body: unknown,
  ): string | undefined => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      // Ein leeres Feld ist keine Aussage — es zu übernehmen hiesse, eine
      // geerbte Aussage zu löschen.
      skipped.push({ scope, owner, key, reason: 'empty' });
      return undefined;
    }
    if (taken.has(key)) {
      skipped.push({ scope, owner, key, reason: 'exists' });
      return undefined;
    }
    return text;
  };

  // --- globale Ebene: agent_instructions --------------------------------
  {
    const taken = existingKeys('global');
    const body = keep('global', undefined, taken, HARNESS_KEY_TOOL_USAGE, input.agentInstructions);
    if (body !== undefined) {
      levels.push({
        scope: 'global',
        sections: [
          {
            key: HARNESS_KEY_TOOL_USAGE,
            kind: 'prose',
            title: 'Tool Usage',
            body,
            mergeStrategy: 'replace',
            order: 10,
          },
        ],
      });
    }
  }

  // --- Projektebene: instructions + Soul ---------------------------------
  const projectSections = new Map<string, PlannedSection[]>();

  for (const project of input.projects) {
    const taken = existingKeys('project', project.id);
    const body = keep('project', project.id, taken, HARNESS_KEY_INSTRUCTIONS, project.instructions);
    if (body === undefined) continue;
    projectSections.set(project.id, [
      {
        key: HARNESS_KEY_INSTRUCTIONS,
        kind: 'prose',
        title: 'Project Instructions',
        body,
        mergeStrategy: 'replace',
        order: 20,
      },
    ]);
  }

  // --- Souls (Projekt *und* Kunde) ---------------------------------------
  const customerSections = new Map<string, PlannedSection[]>();

  for (const soul of input.souls) {
    const scope: HarnessScope = soul.projectId ? 'project' : 'customer';
    const owner = soul.projectId ?? soul.customerId;
    if (!owner) continue;

    const taken = existingKeys(scope, owner);
    const target = scope === 'project' ? projectSections : customerSections;
    const sections = target.get(owner) ?? [];

    for (const spec of HARNESS_SOUL_SECTIONS) {
      const body = keep(scope, owner, taken, spec.key, soul.fields[spec.key]);
      if (body === undefined) continue;
      sections.push({
        key: spec.key,
        kind: 'prose',
        title: spec.label,
        body,
        mergeStrategy: 'replace',
        order: spec.order,
      });
    }

    if (sections.length > 0) target.set(owner, sections);
  }

  for (const [projectId, sections] of projectSections) {
    if (sections.length > 0) levels.push({ scope: 'project', projectId, sections });
  }
  for (const [customerId, sections] of customerSections) {
    if (sections.length > 0) levels.push({ scope: 'customer', customerId, sections });
  }

  return { levels, skipped };
}

/** Zählwerte für die Zusammenfassung am Ende des Laufs. */
export function summarisePlan(plan: MigrationPlan): {
  levels: number;
  sections: number;
  skippedEmpty: number;
  skippedExisting: number;
} {
  return {
    levels: plan.levels.length,
    sections: plan.levels.reduce((sum, level) => sum + level.sections.length, 0),
    skippedEmpty: plan.skipped.filter((s) => s.reason === 'empty').length,
    skippedExisting: plan.skipped.filter((s) => s.reason === 'exists').length,
  };
}
