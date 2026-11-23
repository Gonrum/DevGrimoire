import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isRecord } from '../common/narrow';

/** Body size the global JSON parser accepts (main.ts); anything up to this needs no special treatment. */
export const GLOBAL_JSON_LIMIT_BYTES = 100 * 1024 * 1024;

const FS_FILE_ROUTE = /^\/api\/workspaces\/[^/]+\/fs\/file\/?$/;

export interface FsFileBodyOptions {
  /** Does the request carry a valid credential? (Bearer API key or access token of an active user.) */
  authenticate: (req: Request) => Promise<boolean>;
  /** The editor limit in force, for the `limit` of a 413. */
  editorLimit: () => Promise<number>;
  /** Largest body the big parser accepts. */
  bigLimitBytes: number;
  /** The big JSON parser (`express.json({ limit: bigLimitBytes })`). */
  parser: RequestHandler;
  /** Defaults to the global parser limit; injectable for tests. */
  globalLimitBytes?: number;
}

/**
 * Raises the JSON body limit for `PUT /api/workspaces/:id/fs/file` only, and
 * only for an authenticated caller. The request runs before the Nest guards,
 * so an unauthenticated client must not be able to make the backend buffer
 * 230 MB:
 *  - not that route, or not a PUT: untouched;
 *  - no (or invalid) Content-Length, or a size the global parser takes anyway:
 *    untouched (global parser, its own limit);
 *  - no valid credential: untouched, so the global parser rejects at its limit
 *    without reading the body;
 *  - authenticated and over the big cap: 413 JSON with the editor limit;
 *  - authenticated, within the cap: the big parser.
 */
export function createFsFileBodyMiddleware(opts: FsFileBodyOptions) {
  const globalLimit = opts.globalLimitBytes ?? GLOBAL_JSON_LIMIT_BYTES;
  const tooLarge = (res: Response, next: NextFunction): void => {
    opts.editorLimit().then(
      (limit) => {
        res.status(413).json({
          error: 'request body too large',
          message: `content too large (>${limit} bytes)`,
          limit,
        });
      },
      (e: unknown) => next(e),
    );
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'PUT' || !FS_FILE_ROUTE.test(req.path)) {
      next();
      return;
    }
    const header = req.headers['content-length'];
    if (typeof header !== 'string' || !/^\d+$/.test(header)) {
      next();
      return;
    }
    const length = Number(header);
    if (length <= globalLimit) {
      next();
      return;
    }
    opts.authenticate(req).then(
      (ok) => {
        if (!ok) {
          next();
          return;
        }
        if (length > opts.bigLimitBytes) {
          tooLarge(res, next);
          return;
        }
        opts.parser(req, res, (err?: unknown) => {
          if (isRecord(err) && err.type === 'entity.too.large') {
            tooLarge(res, next);
            return;
          }
          next(err);
        });
      },
      () => next(),
    );
  };
}
