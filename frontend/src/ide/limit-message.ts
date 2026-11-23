import type { TFunction } from 'i18next';
import { errorMessage } from '../lib/narrow';
import { IdeApiError } from './ide-api';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** "5 MB" / "2 GB": the limit as the settings page shows it. */
export function formatLimit(bytes: number): string {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

/**
 * Error text for a failed editor save/open or download. A 413 that names the
 * limit becomes "larger than X, changeable under Settings"; anything else
 * keeps the error's own message.
 */
export function limitAwareMessage(error: unknown, kind: 'editor' | 'download', t: TFunction): string {
  if (error instanceof IdeApiError && error.status === 413 && error.limit !== undefined) {
    const key = kind === 'editor' ? 'ide.editorLimitExceeded' : 'ide.downloadLimitExceeded';
    return t(key, { limit: formatLimit(error.limit) });
  }
  return errorMessage(error);
}
