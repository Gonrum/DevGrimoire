import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Editor: opening and saving one file in the browser IDE. */
export const EDITOR_DEFAULT_BYTES = 5 * MIB;
export const EDITOR_HARD_MAX_BYTES = 100 * MIB;
/** Download (`fs/raw`): streamed, so the limit is only a guard. */
export const DOWNLOAD_DEFAULT_BYTES = 2 * GIB;
export const DOWNLOAD_HARD_MAX_BYTES = 50 * GIB;

export const EDITOR_MAX_BYTES_KEY = 'workspaces.editorMaxBytes';
export const DOWNLOAD_MAX_BYTES_KEY = 'workspaces.downloadMaxBytes';

/**
 * Idle limit of every terminal (SSH connection page, SSH workspace, container
 * workspace): minutes without input and without output. Read when a terminal
 * opens; open terminals keep their limit.
 */
export const TERMINAL_IDLE_KEY = 'terminals.idleMinutes';
export const TERMINAL_IDLE_DEFAULT_MINUTES = 30;
export const TERMINAL_IDLE_MIN_MINUTES = 5;
export const TERMINAL_IDLE_MAX_MINUTES = 1440;

/**
 * Largest JSON body accepted for `PUT /workspaces/:id/fs/file`: the editor
 * hard max, JSON-escaped (about 2.2x for typical source text), plus headroom.
 * Only that route gets this limit; everything else keeps the global 100 MB.
 */
export const FS_FILE_BODY_LIMIT_BYTES = 230 * MIB;

/**
 * Stored setting -> effective limit. Missing, non-numeric or `< 1` falls back
 * to `def`; values above `hardMax` are capped; fractions are floored.
 */
export function clampLimit(raw: string | null, def: number, hardMax: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), hardMax);
}

/**
 * Stored setting -> value in `[min, max]`. Missing or non-numeric falls back
 * to `def`; out-of-range values are clamped; fractions are floored.
 */
export function clampRange(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export interface WorkspaceLimits {
  editorMaxBytes: number;
  downloadMaxBytes: number;
  terminalIdleMinutes: number;
}

function clampIdleMinutes(raw: string | null): number {
  return clampRange(raw, TERMINAL_IDLE_DEFAULT_MINUTES, TERMINAL_IDLE_MIN_MINUTES, TERMINAL_IDLE_MAX_MINUTES);
}

/** Global, admin-set limits for the browser IDE (both workspace kinds). */
@Injectable()
export class WorkspaceLimitsService {
  constructor(private readonly settings: SettingsService) {}

  async get(): Promise<WorkspaceLimits> {
    const [editor, download, idle] = await Promise.all([
      this.settings.get(EDITOR_MAX_BYTES_KEY),
      this.settings.get(DOWNLOAD_MAX_BYTES_KEY),
      this.settings.get(TERMINAL_IDLE_KEY),
    ]);
    return {
      editorMaxBytes: clampLimit(editor, EDITOR_DEFAULT_BYTES, EDITOR_HARD_MAX_BYTES),
      downloadMaxBytes: clampLimit(download, DOWNLOAD_DEFAULT_BYTES, DOWNLOAD_HARD_MAX_BYTES),
      terminalIdleMinutes: clampIdleMinutes(idle),
    };
  }

  /** Effective terminal idle limit in milliseconds. */
  async terminalIdleMs(): Promise<number> {
    return clampIdleMinutes(await this.settings.get(TERMINAL_IDLE_KEY)) * 60_000;
  }
}
