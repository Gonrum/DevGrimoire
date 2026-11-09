import { Types } from 'mongoose';

/**
 * Build a Mongo filter clause that matches a projectId regardless of whether
 * it was stored as ObjectId or as a plain string.
 *
 * Background: the DB has historically stored projectId inconsistently across
 * collections. MCP-tool-created docs, legacy JSON imports, and a few
 * replication paths left string projectIds in some collections, while newer
 * data uses ObjectId. Mongoose 8's default `strictQuery: false` does not
 * always auto-cast query values to the schema type, so a plain `projectId:
 * string` filter can miss ObjectId-stored docs — and vice versa on peer
 * instances where conversion happened on receive.
 *
 * Usage:
 *   if (filters.projectId) query.projectId = projectIdFilter(filters.projectId);
 *
 * Returns an `$in` clause with both representations, or an empty `$in` if
 * the input isn't a valid ObjectId, so the caller gets a deterministic no-
 * match rather than a throw.
 */
export function projectIdFilter(id: string): { $in: Array<string | Types.ObjectId> } {
  // T-510: seit die Felder echte ObjectId-Pfade sind, würde Mongoose einen
  // ungültigen String im Filter nicht mehr „nicht finden", sondern mit einem
  // CastError ablehnen. Ungültig heisst deshalb: leeres `$in`, kein Treffer.
  if (!id || !Types.ObjectId.isValid(id)) return { $in: [] };
  return { $in: [id, new Types.ObjectId(id)] };
}
