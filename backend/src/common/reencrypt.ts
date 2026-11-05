import { decryptWithKey, encryptWithKey } from './encryption.service';
import { isRecord } from './narrow';

/**
 * Umschlüsseln gespeicherter Chiffrate von einem SECRETS_ENCRYPTION_KEY auf
 * einen anderen (T-467). Reine Funktionen — das Skript
 * `scripts/secrets-reencrypt.cjs` liest, schreibt und berichtet nur.
 *
 * Warum nicht nur `secrets.encryptedValue`: Chiffrate stecken auch in
 * Settings (Chat-/LLM-Endpunkte, Websuche, RAG, Workflow-Agent), teils
 * verschachtelt, und im Replikations-Log als Kopie ganzer Dokumente. Eine
 * Liste der Felder wäre beim nächsten neuen Feld veraltet. Stattdessen wird
 * jeder String geprüft, der wie ein Chiffrat *aussieht*, und nur umgeschrieben,
 * was sich mit dem alten Schlüssel *authentifizieren* lässt. AES-GCM macht das
 * sicher: ein zufälliger String im selben Format besteht die Tag-Prüfung
 * praktisch nie (2^-128).
 */

/** Format von `encryptWithKey`: iv(16 B):authTag(16 B):ciphertext, alles hex. */
const CIPHER_RE = /^[0-9a-f]{32}:[0-9a-f]{32}:(?:[0-9a-f]{2})*$/;

export function looksLikeCiphertext(value: string): boolean {
  return CIPHER_RE.test(value);
}

/**
 * - `old`: mit dem alten Schlüssel lesbar → wird umgeschlüsselt
 * - `new`: schon mit dem neuen lesbar → nichts zu tun (Idempotenz)
 * - `unreadable`: mit keinem der beiden lesbar — z. B. ein von der Gegenseite
 *   repliziertes Secret. Wird nie angefasst, nur gemeldet.
 */
export type CipherState = 'old' | 'new' | 'unreadable';

export function classifyCiphertext(value: string, oldKey: Buffer, newKey: Buffer): CipherState {
  if (canDecrypt(oldKey, value)) return 'old';
  if (canDecrypt(newKey, value)) return 'new';
  return 'unreadable';
}

function canDecrypt(key: Buffer, value: string): boolean {
  try {
    decryptWithKey(key, value);
    return true;
  } catch {
    return false;
  }
}

export interface FoundCipher {
  /** Mongo-Punktpfad, Array-Indizes als Segment (`a.0.b`) — direkt für `$set`. */
  path: string;
  state: CipherState;
  /** Nur bei `old`: das neue Chiffrat. */
  replacement?: string;
}

/** Felder, deren Inhalt nie umgeschrieben wird. */
const SKIP_KEYS = new Set(['_id', '__v']);

/**
 * Sucht alle Chiffrate in einem Dokument und berechnet für die alten das neue
 * Chiffrat. Schreibt nichts. BSON-Typen (ObjectId, Date, Binary …) werden
 * nicht betreten (`isOpaque`), `_id` und `__v` auf oberster Ebene übersprungen.
 */
export function planDocument(doc: unknown, oldKey: Buffer, newKey: Buffer): FoundCipher[] {
  const out: FoundCipher[] = [];
  walk(doc, '', (path, value) => {
    if (!looksLikeCiphertext(value)) return;
    const state = classifyCiphertext(value, oldKey, newKey);
    if (state === 'old') {
      out.push({ path, state, replacement: encryptWithKey(newKey, decryptWithKey(oldKey, value)) });
    } else {
      out.push({ path, state });
    }
  });
  return out;
}

function walk(node: unknown, path: string, visit: (path: string, value: string) => void): void {
  if (typeof node === 'string') {
    if (path) visit(path, node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i), visit));
    return;
  }
  if (!isRecord(node) || isOpaque(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (!path && SKIP_KEYS.has(key)) continue;
    walk(value, path ? `${path}.${key}` : key, visit);
  }
}

/** BSON-/Node-Typen, die keine Feld-Struktur haben, in die man absteigen sollte. */
function isOpaque(node: Record<string, unknown>): boolean {
  if (node instanceof Date || Buffer.isBuffer(node)) return true;
  // ObjectId, Decimal128, Binary, Long … tragen `_bsontype`.
  return typeof node._bsontype === 'string';
}

/** Schlüssel aus Hex (64 Zeichen) — sonst ein klarer Fehler statt eines stillen Fehlschlags. */
export function parseKey(hex: string | undefined, label: string): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label} muss 64 Hex-Zeichen (32 Byte) lang sein`);
  }
  return Buffer.from(hex, 'hex');
}
