import { Schema, Types } from 'mongoose';
import type { Db } from 'mongodb';
import { isDuplicateKeyError, isRecord, isUnknownArray } from './narrow';

/**
 * T-510: Referenzen, die als String statt als ObjectId gespeichert sind, in
 * ObjectIds wandeln.
 *
 * `@Prop({ type: Types.ObjectId })` legte bei @nestjs/mongoose ein Mixed-Feld
 * an; Mongoose castete diese Felder nie, und alles, was als String hereinkam
 * (MCP, REST-DTOs, Replikation), liegt als String. Seit T-510 sind es echte
 * ObjectId-Pfade: Mongoose castet String-Filter jetzt zu ObjectIds, und als
 * String gespeicherte Dokumente fielen ohne diese Migration aus jeder Abfrage.
 *
 * Läuft einmal beim Start (main.ts, vor `listen`) und als Skript
 * (`scripts/objectid-migrate.cjs`, Trockenlauf zum Messen).
 *
 * Regeln:
 *   - 24-Hex-String → ObjectId; '' → null (leeres Formularfeld = kein Verweis)
 *   - alles andere bleibt stehen und wird gemeldet (z. B. ein Projekt-Slug,
 *     der versehentlich als projectId gespeichert wurde) — Mongoose liest so
 *     einen Wert als `undefined`, ohne zu werfen
 *   - Unique-Konflikt (dieselbe Referenz gab es schon als ObjectId): Dokument
 *     bleibt unverändert, wird gemeldet, der Lauf geht weiter
 *   - jeder Schreibvorgang ist an den alten Wert des obersten Feldes gebunden
 *   - idempotent
 */

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** `[]` steht für „jedes Array-Element“: `['steps', '[]', 'todoId']`. */
export type ObjectIdPath = string[];

export interface PathStats {
  castable: number;
  uncastable: number;
  samples: Array<{ id: string; value: string }>;
}

export interface CollectionReport {
  collection: string;
  docs: number;
  written: number;
  raced: number;
  conflicts: string[];
  paths: Record<string, PathStats>;
}

/** Ein Element-Typ eines Mongoose-Arrays (Mongoose 8: `embeddedSchemaType`, älter: `caster`). */
function arrayElementType(type: unknown): unknown {
  if (!isRecord(type)) return undefined;
  return type.embeddedSchemaType ?? type.caster;
}

function subSchema(type: unknown): Schema | undefined {
  return isRecord(type) && type.schema instanceof Schema ? type.schema : undefined;
}

function instanceOf(type: unknown): unknown {
  return isRecord(type) ? type.instance : undefined;
}

/** ObjectId-Pfade eines Schemas, inkl. Arrays, verschachtelter Objekte und Subdokument(-Array)s. */
export function objectIdPaths(schema: Schema, prefix: ObjectIdPath = []): ObjectIdPath[] {
  const out: ObjectIdPath[] = [];
  schema.eachPath((p, type: unknown) => {
    if (p === '_id' || p === '__v') return;
    const segs = [...prefix, ...p.split('.')];
    const instance = instanceOf(type);
    const nested = subSchema(type);
    if (instance === 'ObjectId') {
      out.push(segs);
    } else if (nested && isRecord(type) && type.$isMongooseDocumentArray) {
      out.push(...objectIdPaths(nested, [...segs, '[]']));
    } else if (nested && isRecord(type) && type.$isSingleNested) {
      out.push(...objectIdPaths(nested, segs));
    } else if (instance === 'Array') {
      let inner: unknown = type;
      const arr = [...segs];
      while (instanceOf(inner) === 'Array') {
        arr.push('[]');
        inner = arrayElementType(inner);
      }
      if (instanceOf(inner) === 'ObjectId') out.push(arr);
    }
  });
  return out;
}

type OnString = (value: string, castable: boolean) => void;

/**
 * Wandelt entlang `segs` alle String-Werte. Mutiert nichts; ohne Änderung
 * kommt dieselbe Referenz zurück.
 */
export function convertAt(value: unknown, segs: ObjectIdPath, onString: OnString): unknown {
  if (segs.length === 0) {
    if (typeof value !== 'string') return value;
    if (value === '') {
      onString(value, true);
      return null;
    }
    const castable = OBJECT_ID_HEX.test(value);
    onString(value, castable);
    return castable ? new Types.ObjectId(value) : value;
  }
  const [head, ...rest] = segs;
  if (head === '[]') {
    if (!isUnknownArray(value)) return value;
    let changed = false;
    const next = value.map((el) => {
      const c = convertAt(el, rest, onString);
      if (c !== el) changed = true;
      return c;
    });
    return changed ? next : value;
  }
  if (!isRecord(value) || Array.isArray(value) || value instanceof Types.ObjectId || value instanceof Date) {
    return value;
  }
  if (!(head in value)) return value;
  const c = convertAt(value[head], rest, onString);
  return c === value[head] ? value : { ...value, [head]: c };
}

export interface DocumentPlan {
  /** Neuer Wert pro oberstem Feld — nur geänderte. */
  sets: Record<string, unknown>;
  findings: Array<{ path: string; value: string; castable: boolean }>;
}

export function planDocument(doc: Record<string, unknown>, paths: ObjectIdPath[]): DocumentPlan {
  const sets: Record<string, unknown> = {};
  const findings: DocumentPlan['findings'] = [];
  for (const segs of paths) {
    const top = segs[0];
    const current = top in sets ? sets[top] : doc[top];
    if (current === undefined) continue;
    const label = segs.join('.').replace(/\.\[\]/g, '[]');
    const next = convertAt(current, segs.slice(1), (value, castable) => findings.push({ path: label, value, castable }));
    if (next !== current) sets[top] = next;
  }
  return { sets, findings };
}

/** Collection → vereinigte Pfadliste aus registrierten Modellen. */
export function pathsByCollection(models: Iterable<{ schema: Schema; collection: { collectionName: string } }>): Map<string, ObjectIdPath[]> {
  const byColl = new Map<string, ObjectIdPath[]>();
  for (const model of models) {
    const paths = objectIdPaths(model.schema);
    if (paths.length === 0) continue;
    const coll = model.collection.collectionName;
    const prev = byColl.get(coll) ?? [];
    const seen = new Set(prev.map((s) => s.join('.')));
    for (const s of paths) if (!seen.has(s.join('.'))) prev.push(s);
    byColl.set(coll, prev);
  }
  return byColl;
}

/** Trifft Dokumente mit mindestens einem String in einem der Pfade. */
export function stringFilter(paths: ObjectIdPath[]): Record<string, unknown> {
  return { $or: paths.map((segs) => ({ [segs.filter((s) => s !== '[]').join('.')]: { $type: 'string' } })) };
}

const MAX_SAMPLES = 50;

export async function migrateObjectIds(
  db: Db,
  byColl: Map<string, ObjectIdPath[]>,
  options: { apply?: boolean; collections?: string[] | null } = {},
): Promise<CollectionReport[]> {
  const apply = options.apply ?? false;
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const report: CollectionReport[] = [];
  for (const [coll, paths] of [...byColl.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (options.collections && !options.collections.includes(coll)) continue;
    if (!existing.has(coll)) continue;
    const c = db.collection(coll);
    const perPath = new Map<string, PathStats>();
    const entry: CollectionReport = { collection: coll, docs: 0, written: 0, raced: 0, conflicts: [], paths: {} };
    for await (const doc of c.find(stringFilter(paths))) {
      const { sets, findings } = planDocument(doc, paths);
      if (findings.length === 0) continue;
      entry.docs += 1;
      for (const f of findings) {
        const e = perPath.get(f.path) ?? { castable: 0, uncastable: 0, samples: [] };
        if (f.castable) e.castable += 1;
        else {
          e.uncastable += 1;
          if (e.samples.length < MAX_SAMPLES) e.samples.push({ id: String(doc._id), value: f.value });
        }
        perPath.set(f.path, e);
      }
      if (!apply || Object.keys(sets).length === 0) continue;
      const filter: Record<string, unknown> = { _id: doc._id };
      for (const k of Object.keys(sets)) filter[k] = doc[k];
      try {
        const res = await c.updateOne(filter, { $set: sets });
        if (res.modifiedCount === 1) entry.written += 1;
        else entry.raced += 1;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        entry.conflicts.push(String(doc._id));
      }
    }
    entry.paths = Object.fromEntries(perPath);
    if (perPath.size > 0) report.push(entry);
  }
  return report;
}

/** Marker in `migrations`: nach einem vollständigen Lauf wird der Start-Lauf übersprungen. */
export const OBJECTID_MIGRATION_ID = 't510-objectid-refs';
