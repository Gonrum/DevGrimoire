import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import Busboy from 'busboy';
import { Types } from 'mongoose';
import { SshService } from './ssh.service';
import { errorMessage } from '../common/narrow';
import { SshTestService } from './ssh-test.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SshAudit,
  SshAuditDocument,
} from './schemas/ssh-audit.schema';
import { CreateSshConnectionDto } from './dto/create-ssh-connection.dto';
import { UpdateSshConnectionDto } from './dto/update-ssh-connection.dto';
import { TestSshConnectionDto } from './dto/test-ssh-connection.dto';
import { AcceptFingerprintDto } from './dto/accept-fingerprint.dto';
import { AuditQueryDto } from './dto/audit-query.dto';
import { ListSshConnectionsDto } from './dto/list-ssh-connections.dto';
import { SshConnectionDocument } from './schemas/ssh-connection.schema';
import { SshConnectionWithInheritance } from './ssh.service';
import { SshSessionService } from './ssh-session.service';
import { SettingsService } from '../settings/settings.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import {
  computeEffectiveUploadLimit,
  SFTP_HARD_MAX_UPLOAD_BYTES,
  SFTP_DEFAULT_UPLOAD_BYTES,
} from './upload-limit.util';

interface AuthRequest {
  user?: { userId?: string };
}

/**
 * REST surface for SSH connections.
 *
 * Routing choice (Schritt 2/8): a single flat controller mounted at root that
 * exposes both the canonical `/api/ssh-connections/...` endpoints AND the
 * nested-scope listing routes from spec §4.2 (`/api/customers/:id/...`,
 * `/api/projects/:id/...`). The flat root pattern mirrors how
 * `MonitoringController` lives in the codebase — same controller hosts both
 * nested listing and flat detail routes — so we don't fragment SSH across two
 * controllers just to satisfy a URL aesthetic.
 *
 * Auth: `JwtAuthGuard` is wired globally in app.module.ts, so no `@UseGuards`
 * decoration is needed at this layer. `req.user.userId` is populated by the
 * guard (or by the system-user fallback when auth is disabled).
 *
 * Detail responses never include plaintext credentials; only Secret IDs
 * (referential, harmless) flow back to the client.
 */
@Controller()
export class SshController {
  constructor(
    private readonly sshService: SshService,
    private readonly sshTestService: SshTestService,
    @InjectModel(SshAudit.name)
    private readonly auditModel: Model<SshAuditDocument>,
    private readonly settingsService: SettingsService,
    private readonly sshSessionService: SshSessionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Global SSH config (admin-only)
  // ---------------------------------------------------------------------------

  @Get('ssh-config')
  async getConfig() {
    const raw = await this.settingsService.get('ssh.maxUploadBytes');
    const parsed = raw !== null ? Number.parseInt(raw, 10) : NaN;
    const maxUploadBytes = computeEffectiveUploadLimit(
      Number.isNaN(parsed) ? null : parsed,
      null,
    );
    return {
      maxUploadBytes,
      hardMaxBytes: SFTP_HARD_MAX_UPLOAD_BYTES,
      defaultBytes: SFTP_DEFAULT_UPLOAD_BYTES,
    };
  }

  @Put('ssh-config')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async setConfig(@Body() body: { maxUploadBytes?: number }) {
    const value = body?.maxUploadBytes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      throw new BadRequestException(
        'maxUploadBytes must be a positive integer (bytes)',
      );
    }
    if (value > SFTP_HARD_MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `maxUploadBytes exceeds the 500 MB hard ceiling (${SFTP_HARD_MAX_UPLOAD_BYTES})`,
      );
    }
    const clamped = Math.floor(value);
    await this.settingsService.set('ssh.maxUploadBytes', String(clamped));
    return {
      maxUploadBytes: clamped,
      hardMaxBytes: SFTP_HARD_MAX_UPLOAD_BYTES,
      defaultBytes: SFTP_DEFAULT_UPLOAD_BYTES,
    };
  }

  // ---------------------------------------------------------------------------
  // Listing (nested + flat)
  // ---------------------------------------------------------------------------

  @Get('customers/:id/ssh-connections')
  listForCustomer(@Param('id') customerId: string) {
    return this.sshService
      .findByCustomerId(customerId)
      .then((docs) => docs.map((d) => this.toListItem(d)));
  }

  @Get('projects/:id/ssh-connections')
  listForProject(@Param('id') projectId: string) {
    return this.sshService
      .findByProjectId(projectId)
      .then((docs) => docs.map((d) => this.toListItem(d)));
  }

  @Get('ssh-connections')
  async listByQuery(@Query() q: ListSshConnectionsDto) {
    if (!q.customerId && !q.projectId) {
      throw new BadRequestException(
        'customerId or projectId query parameter is required',
      );
    }
    if (q.customerId && q.projectId) {
      throw new BadRequestException(
        'customerId and projectId are mutually exclusive',
      );
    }
    const docs = q.customerId
      ? await this.sshService.findByCustomerId(q.customerId)
      : await this.sshService.findByProjectId(q.projectId!);
    return docs.map((d) => this.toListItem(d));
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  @Post('ssh-connections')
  @HttpCode(201)
  async create(
    @Body() dto: CreateSshConnectionDto,
    @Req() req: AuthRequest,
  ) {
    const userId = req.user?.userId || 'system';
    const created = await this.sshService.create(dto, userId);
    return this.toDetail(created);
  }

  @Get('ssh-connections/:id')
  async findOne(@Param('id') id: string) {
    const doc = await this.sshService.findById(id);
    return this.toDetail(doc);
  }

  @Patch('ssh-connections/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSshConnectionDto,
  ) {
    const updated = await this.sshService.update(id, dto);
    return this.toDetail(updated);
  }

  @Delete('ssh-connections/:id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.sshService.delete(id);
  }

  /**
   * Streaming file upload to a remote host via SFTP. The multipart file part is
   * piped straight into sftpUploadStream — never buffered in full — so large
   * files are handled within the connection's effective upload limit. The
   * global express.json parser ignores multipart bodies, so busboy owns the
   * raw request here. Send `remotePath` (and any `createDirs`/`mode`) as form
   * fields BEFORE the file part so they are parsed when the file stream opens.
   */
  @Post('ssh-connections/:id/upload')
  async uploadFile(
    @Param('id') id: string,
    @Req() req: Request & AuthRequest,
  ): Promise<{ bytesWritten: number; remotePath: string }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid SshConnection id');
    }
    const userId = req.user?.userId || 'system';

    return new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers });
      const fields: Record<string, string> = {};
      let fileSeen = false;
      let settled = false;
      // Zwei getrennte Funktionen statt einer gemeinsamen: ein geteiltes
      // `settle(fn, arg)` müsste `fn` als `(v: never) => void` typisieren, damit
      // resolve und reject beide hineinpassen — und bräuchte dann einen Cast am
      // Aufruf. So bleibt beides typisiert und der Once-Guard trotzdem geteilt.
      const settleResolve = (value: { bytesWritten: number; remotePath: string }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleReject = (reason: unknown) => {
        if (settled) return;
        settled = true;
        // HttpExceptions und ssh2-Fehler sind Errors und gehen unverändert
        // durch; alles andere wird eingepackt, damit die Promise nie mit einem
        // Nicht-Error rejected (Nest sähe dann nur ein leeres 500).
        reject(reason instanceof Error ? reason : new Error(errorMessage(reason)));
      };

      bb.on('field', (name, val) => {
        fields[name] = val;
      });

      bb.on('file', (_name, fileStream) => {
        fileSeen = true;
        const remotePath = fields.remotePath;
        if (!remotePath) {
          fileStream.resume(); // drain so busboy can finish
          settleReject(
            new BadRequestException(
              'remotePath field is required (send it before the file part)',
            ),
          );
          return;
        }
        const createDirs = fields.createDirs === 'true';
        const mode = fields.mode ? Number.parseInt(fields.mode, 10) : undefined;
        // Attach handlers directly so a rejection is never left unhandled and,
        // crucially, drain the file part on failure — otherwise busboy never
        // emits 'close' and the request hangs (e.g. connection-not-found).
        this.sshSessionService
          .sftpUploadStream(id, remotePath, fileStream, {
            createDirs,
            mode,
            sourceContext: 'rest',
            userId,
          })
          .then((res) => settleResolve(res))
          .catch((err) => {
            fileStream.resume();
            settleReject(err);
          });
      });

      bb.on('close', () => {
        if (!fileSeen) {
          settleReject(new BadRequestException('no file part in multipart body'));
        }
      });

      bb.on('error', (err) => settleReject(err));
      req.pipe(bb);
    });
  }

  // ---------------------------------------------------------------------------
  // Test + TOFU
  // ---------------------------------------------------------------------------

  /**
   * One-shot connect probe via ssh2. Returns a structured result containing
   * `ok`, optional `fingerprint` for the UI's accept-dialog, and an error code
   * on failure. Does NOT throw on auth/host errors — only 404 (not found)
   * bubbles out.
   */
  @Post('ssh-connections/:id/test')
  @HttpCode(200)
  async test(
    @Param('id') id: string,
    @Body() _dto: TestSshConnectionDto, // body currently unused, kept for forward-compat
    @Req() req: AuthRequest,
  ) {
    // Touch dto so Nest's ValidationPipe still gets to validate the body.
    void _dto;
    const userId = req.user?.userId;
    return this.sshTestService.testConnection(id, { userId });
  }

  /**
   * TOFU accept: persist a known-good fingerprint after the user confirmed
   * it in the dialog. Body fingerprint format is locked down by the DTO
   * regex so we don't store malformed strings that later mismatch on every
   * reconnect.
   */
  @Post('ssh-connections/:id/accept-fingerprint')
  @HttpCode(200)
  async acceptFingerprint(
    @Param('id') id: string,
    @Body() dto: AcceptFingerprintDto,
  ) {
    const updated = await this.sshService.setKnownHostFingerprint(
      id,
      dto.fingerprint,
    );
    return this.toDetail(updated);
  }

  // ---------------------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------------------

  @Get('ssh-connections/:id/audit')
  async audit(
    @Param('id') id: string,
    @Query() q: AuditQueryDto,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid SshConnection id');
    }
    // Touch the connection so callers get a clean 404 instead of an empty
    // list when the id is wrong.
    await this.sshService.findById(id);

    const filter: Record<string, unknown> = {
      connectionId: new Types.ObjectId(id),
    };
    if (q.sourceContext) filter.sourceContext = q.sourceContext;

    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const [items, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ at: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec(),
      this.auditModel.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, offset };
  }

  // ---------------------------------------------------------------------------
  // Response shaping — strip credentials, surface only safe references.
  // ---------------------------------------------------------------------------

  private toListItem(doc: SshConnectionDocument): Record<string, unknown> {
    // Project-scoped lists may carry an inherited-from-customer marker
    // (T-386). The field is synthetic — stamped by SshService.findByProjectId
    // for connections that belong to a customer linked to the queried
    // project. Frontend uses it to hide edit/delete affordances on the
    // inherited cards.
    const inheritedFromCustomerId = (doc as SshConnectionWithInheritance)
      .inheritedFromCustomerId;
    return {
      id: doc._id.toString(),
      label: doc.label,
      slug: doc.slug,
      customerId: doc.customerId?.toString(),
      projectId: doc.projectId?.toString(),
      host: doc.host,
      port: doc.port,
      username: doc.username,
      authMethod: doc.authMethod,
      tags: doc.tags,
      knownHostFingerprintSet: !!doc.knownHostFingerprint,
      lastConnectedAt: doc.lastConnectedAt,
      lastConnectError: doc.lastConnectError,
      notifyOnAuthFailure: doc.notifyOnAuthFailure,
      maxUploadBytes: doc.maxUploadBytes,
      ...(inheritedFromCustomerId ? { inheritedFromCustomerId } : {}),
    };
  }

  /**
   * Detail-shape: same as list-shape PLUS Secret-id references AND the
   * known-host fingerprint itself (the user accepted it; rendering it in
   * the UI is the point of TOFU). Plaintext credential material is NEVER
   * included.
   */
  private toDetail(doc: SshConnectionDocument): Record<string, unknown> {
    return {
      ...this.toListItem(doc),
      description: doc.description,
      privateKeySecretId: doc.privateKeySecretId?.toString(),
      passphraseSecretId: doc.passphraseSecretId?.toString(),
      passwordSecretId: doc.passwordSecretId?.toString(),
      knownHostFingerprint: doc.knownHostFingerprint,
    };
  }
}
