/**
 * Upload-Grenze für Anhänge (`MINIO_MAX_FILE_SIZE`, Default 50 MB).
 *
 * Eine Stelle für REST (Multer) UND Service (M-46): vorher galt die Grenze nur
 * im Multer-Interceptor des REST-Uploads. Der MCP-Pfad (`createFromBase64`)
 * und Chat-Anhänge gingen an ihr vorbei — begrenzt nur durch das 100-MB-JSON-
 * Limit, also bis ~75 MB decodiert, egal was der Admin konfiguriert hatte.
 */
export const MAX_ATTACHMENT_SIZE = (() => {
  const n = parseInt(process.env.MINIO_MAX_FILE_SIZE || '', 10);
  return Number.isInteger(n) && n > 0 ? n : 50 * 1024 * 1024;
})();

/** Decodierte Größe eines Base64-Strings, ohne ihn zu decodieren. */
export function base64DecodedSize(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}
