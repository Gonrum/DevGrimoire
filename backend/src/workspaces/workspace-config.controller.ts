import { BadRequestException, Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { isRecord } from '../common/narrow';
import {
  DOWNLOAD_DEFAULT_BYTES,
  DOWNLOAD_HARD_MAX_BYTES,
  DOWNLOAD_MAX_BYTES_KEY,
  EDITOR_DEFAULT_BYTES,
  EDITOR_HARD_MAX_BYTES,
  EDITOR_MAX_BYTES_KEY,
  TERMINAL_IDLE_DEFAULT_MINUTES,
  TERMINAL_IDLE_KEY,
  TERMINAL_IDLE_MAX_MINUTES,
  TERMINAL_IDLE_MIN_MINUTES,
  WorkspaceLimitsService,
} from './workspace-limits.service';

/** Validates one optional limit from the PUT body; `undefined` = not sent. */
function readLimit(body: Record<string, unknown>, name: string, hardMax: number): number | undefined {
  if (!(name in body) || body[name] === undefined) return undefined;
  const value = body[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new BadRequestException(`${name} must be a positive number (bytes)`);
  }
  if (value > hardMax) {
    throw new BadRequestException(`${name} exceeds the hard ceiling (${hardMax})`);
  }
  return Math.floor(value);
}

/** Validates the optional terminal idle limit (minutes); `undefined` = not sent. */
function readIdleMinutes(body: Record<string, unknown>): number | undefined {
  if (!('terminalIdleMinutes' in body) || body.terminalIdleMinutes === undefined) return undefined;
  const value = body.terminalIdleMinutes;
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < TERMINAL_IDLE_MIN_MINUTES || value > TERMINAL_IDLE_MAX_MINUTES) {
    throw new BadRequestException(
      `terminalIdleMinutes must be a number between ${TERMINAL_IDLE_MIN_MINUTES} and ${TERMINAL_IDLE_MAX_MINUTES}`,
    );
  }
  return Math.floor(value);
}

/**
 * Global limits of the browser IDE: editor (open/save) and download, plus
 * the idle limit of all terminals. Same pattern as `ssh-config`: everyone may
 * read, only admins may change.
 */
@Controller('workspace-config')
export class WorkspaceConfigController {
  constructor(
    private readonly limits: WorkspaceLimitsService,
    private readonly settings: SettingsService,
  ) {}

  private async view() {
    const current = await this.limits.get();
    return {
      ...current,
      editorDefaultBytes: EDITOR_DEFAULT_BYTES,
      editorHardMaxBytes: EDITOR_HARD_MAX_BYTES,
      downloadDefaultBytes: DOWNLOAD_DEFAULT_BYTES,
      downloadHardMaxBytes: DOWNLOAD_HARD_MAX_BYTES,
      terminalIdleDefaultMinutes: TERMINAL_IDLE_DEFAULT_MINUTES,
      terminalIdleMinMinutes: TERMINAL_IDLE_MIN_MINUTES,
      terminalIdleMaxMinutes: TERMINAL_IDLE_MAX_MINUTES,
    };
  }

  @Get()
  getConfig() {
    return this.view();
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async setConfig(@Body() body: unknown) {
    if (!isRecord(body)) throw new BadRequestException('body must be an object');
    const editor = readLimit(body, 'editorMaxBytes', EDITOR_HARD_MAX_BYTES);
    const download = readLimit(body, 'downloadMaxBytes', DOWNLOAD_HARD_MAX_BYTES);
    const idle = readIdleMinutes(body);
    if (editor === undefined && download === undefined && idle === undefined) {
      throw new BadRequestException('editorMaxBytes, downloadMaxBytes or terminalIdleMinutes is required');
    }
    // Validate everything first, then write: no half-applied update.
    if (editor !== undefined) await this.settings.set(EDITOR_MAX_BYTES_KEY, String(editor));
    if (download !== undefined) await this.settings.set(DOWNLOAD_MAX_BYTES_KEY, String(download));
    if (idle !== undefined) await this.settings.set(TERMINAL_IDLE_KEY, String(idle));
    return this.view();
  }
}
