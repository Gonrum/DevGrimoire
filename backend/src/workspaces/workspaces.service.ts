import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Workspace, WorkspaceDocument, WorkspaceStatus } from './schemas/workspace.schema';
import { isDuplicateKeyError } from '../common/narrow';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import { actorCanAccessProject } from '../common/permissions';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { SshService } from '../ssh/ssh.service';
import { SshConnectionDocument } from '../ssh/schemas/ssh-connection.schema';
import { normalizeRemotePath } from './remote-path';
import {
  AGENT_ALLOW_MAX_ENTRIES,
  AgentAllowInput,
  parseAgentAllowInput,
} from './agent-allow';
import { SshWorkspaceSessions } from './fs/ssh-workspace-sessions.service';

const TOUCH_THROTTLE_MS = 60_000;

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);
  private readonly lastTouch = new Map<string, number>();

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<WorkspaceDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly ssh: SshService,
    // Optional so checks can build the service without the session holder.
    @Optional() private readonly sessions?: SshWorkspaceSessions,
  ) {}

  /**
   * Hook for the "directory exists" check of an SSH workspace (SFTP stat).
   * Unset until the SSH file backend registers it; when unset the check is
   * skipped. Called last, after every other validation passed.
   */
  verifyRemoteDir?: (connection: SshConnectionDocument, remotePath: string) => Promise<void>;

  /**
   * Projekt-Scope (C-10). Ein Workspace ist ein Shell-fähiger Container mit
   * den Git-Tokens seines Projekts im Env — wer ihn erreicht, führt dort
   * beliebige Kommandos aus. Bis hierhin war die 24-Hex-Id die einzige Hürde
   * (REST /exec/stream, alle workspace_*-MCP-Tools); nur der WS-Terminal-Pfad
   * in main.ts prüfte den Scope.
   *
   * `if (actor)` nach der Projekt-Konvention: ohne Actor ist der Aufrufer
   * intern (TTL-Sweep, stdio-MCP).
   */
  private assertProjectAccess(projectId: string | Types.ObjectId | undefined): void {
    const actor = RequestContext.getUser();
    if (!actor) return;
    if (!actorCanAccessProject(actor, projectId?.toString())) {
      throw new ForbiddenException('Kein Zugriff auf den Workspace dieses Projekts');
    }
  }

  /**
   * Validates the SSH part of a create request (spec "Anlegen" 1-4, errors are
   * 400 except the connection access denial, 403) and returns the normalised
   * remote path plus the connection.
   */
  private async validateSsh(
    dto: CreateWorkspaceDto,
  ): Promise<{ connection: SshConnectionDocument; remotePath: string }> {
    if (dto.repoUrl !== undefined || dto.branch !== undefined || dto.gitRepoId !== undefined) {
      throw new BadRequestException('repoUrl, branch and gitRepoId are not allowed for SSH workspaces');
    }
    if (!dto.sshConnectionId) {
      throw new BadRequestException('sshConnectionId is required for SSH workspaces');
    }
    if (dto.remotePath === undefined) {
      throw new BadRequestException('remotePath is required for SSH workspaces');
    }
    const remotePath = normalizeRemotePath(dto.remotePath);
    let connection: SshConnectionDocument;
    try {
      // Enforces the actor's scope on the connection (403).
      connection = await this.ssh.findById(dto.sshConnectionId);
    } catch (err: unknown) {
      if (err instanceof NotFoundException) {
        throw new BadRequestException('SSH connection does not exist');
      }
      throw err;
    }
    const usable = await this.ssh.findByProjectId(dto.projectId);
    if (!usable.some((c) => String(c._id) === String(connection._id))) {
      throw new BadRequestException('SSH connection is not usable for this project');
    }
    return { connection, remotePath };
  }

  async create(dto: CreateWorkspaceDto): Promise<WorkspaceDocument> {
    this.assertProjectAccess(dto.projectId);
    const _id = new Types.ObjectId();
    let path = `/workspaces/${_id.toHexString()}/`;
    let sshFields: { sshConnectionId: Types.ObjectId; remotePath: string } | undefined;
    if (dto.location === 'ssh') {
      const { connection, remotePath } = await this.validateSsh(dto);
      if (this.verifyRemoteDir) await this.verifyRemoteDir(connection, remotePath);
      path = remotePath;
      sshFields = { sshConnectionId: connection._id, remotePath };
    } else if (dto.sshConnectionId !== undefined || dto.remotePath !== undefined) {
      throw new BadRequestException('sshConnectionId and remotePath require location "ssh"');
    }
    try {
      const ws = await this.workspaceModel.create({
        _id,
        projectId: new Types.ObjectId(dto.projectId),
        name: dto.name,
        description: dto.description,
        location: sshFields ? 'ssh' : 'container',
        ...(sshFields ?? {}),
        ...(sshFields
          ? {}
          : { repoUrl: dto.repoUrl, branch: dto.branch ?? 'main', gitRepoId: dto.gitRepoId }),
        path,
        status: 'active',
        sizeBytes: 0,
        lastActivityAt: new Date(),
        createdBySessionId: dto.createdBySessionId,
      });
      this.emit(ws, 'created', `Workspace "${ws.name}" erstellt`);
      return ws;
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Workspace "${dto.name}" already exists in project ${dto.projectId}`,
        );
      }
      throw err;
    }
  }

  async findByProject(
    projectId: string,
    status?: WorkspaceStatus,
  ): Promise<WorkspaceDocument[]> {
    this.assertProjectAccess(projectId);
    const query: Record<string, unknown> = { projectId: new Types.ObjectId(projectId) };
    if (status) query.status = status;
    return this.workspaceModel.find(query).sort({ lastActivityAt: -1 }).exec();
  }

  async findById(id: string): Promise<WorkspaceDocument> {
    const ws = await this.workspaceModel.findById(id).exec();
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    this.assertProjectAccess(ws.projectId);
    return ws;
  }

  async findByName(projectId: string, name: string): Promise<WorkspaceDocument> {
    this.assertProjectAccess(projectId);
    const ws = await this.workspaceModel
      .findOne({ projectId: new Types.ObjectId(projectId), name })
      .exec();
    if (!ws) {
      throw new NotFoundException(`Workspace "${name}" not found in project ${projectId}`);
    }
    return ws;
  }

  async update(id: string, dto: UpdateWorkspaceDto): Promise<WorkspaceDocument> {
    // Laden und prüfen VOR findByIdAndUpdate — sonst wäre erst geschrieben.
    const current = await this.findById(id);
    // Same rule as at create: an SSH workspace has no repository fields.
    if (
      current.location === 'ssh'
      && (dto.repoUrl !== undefined || dto.branch !== undefined || dto.gitRepoId !== undefined)
    ) {
      throw new BadRequestException('repoUrl, branch and gitRepoId are not allowed for SSH workspaces');
    }
    try {
      const ws = await this.workspaceModel
        .findByIdAndUpdate(id, { ...dto, lastActivityAt: new Date() }, { new: true })
        .exec();
      if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
      this.emit(ws, 'updated', `Workspace "${ws.name}" aktualisiert`);
      return ws;
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Workspace name "${dto.name}" already exists in this project`,
        );
      }
      throw err;
    }
  }

  /**
   * Adds an "always allow" rule. Duplicates (same kind, and for commands the
   * same match + value) are not stored twice; the 101st distinct rule is a 400.
   * The push is one atomic update guarded by the same conditions, so parallel
   * requests cannot exceed the cap or double an entry.
   */
  async addAgentAllow(id: string, raw: Parameters<typeof parseAgentAllowInput>[0]): Promise<WorkspaceDocument> {
    const input: AgentAllowInput = parseAgentAllowInput(raw);
    const current = await this.findById(id);
    const same = input.kind === 'command'
      ? { kind: 'command', match: input.match, value: input.value }
      : { kind: input.kind };
    const exists = (ws: WorkspaceDocument) =>
      (ws.agentAllow ?? []).some((e) =>
        e.kind === input.kind
        && (input.kind !== 'command' || (e.kind === 'command' && e.match === input.match && e.value === input.value)));
    if (exists(current)) return current;
    const updated = await this.workspaceModel
      .findOneAndUpdate(
        {
          _id: current._id,
          [`agentAllow.${AGENT_ALLOW_MAX_ENTRIES - 1}`]: { $exists: false },
          agentAllow: { $not: { $elemMatch: same } },
        },
        { $push: { agentAllow: { ...same, createdAt: new Date() } } },
        { new: true },
      )
      .exec();
    if (updated) return updated;
    const fresh = await this.findById(id);
    if (exists(fresh)) return fresh;
    throw new BadRequestException(`At most ${AGENT_ALLOW_MAX_ENTRIES} agent-allow rules per workspace`);
  }

  async removeAgentAllow(id: string, entryId: string): Promise<void> {
    await this.findById(id);
    if (!/^[0-9a-f]{24}$/i.test(entryId)) throw new NotFoundException('Agent-allow entry not found');
    const res = await this.workspaceModel
      .updateOne(
        { _id: new Types.ObjectId(id), 'agentAllow._id': new Types.ObjectId(entryId) },
        { $pull: { agentAllow: { _id: new Types.ObjectId(entryId) } } },
      )
      .exec();
    if (res.modifiedCount === 0) throw new NotFoundException('Agent-allow entry not found');
  }

  async archive(id: string): Promise<WorkspaceDocument> {
    await this.findById(id);
    const ws = await this.workspaceModel
      .findByIdAndUpdate(id, { status: 'archived', lastActivityAt: new Date() }, { new: true })
      .exec();
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    this.sessions?.drop(ws._id.toString());
    this.emit(ws, 'updated', `Workspace "${ws.name}" archiviert`);
    return ws;
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    const ws = await this.workspaceModel.findByIdAndDelete(id).exec();
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    this.sessions?.drop(ws._id.toString());
    this.emit(ws, 'deleted', `Workspace "${ws.name}" gelöscht`);
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.workspaceModel
      .deleteMany({ projectId: new Types.ObjectId(projectId) })
      .exec();
  }

  /**
   * Bumps `lastActivityAt` and optionally updates `sizeBytes`. Used by the
   * MCP read-only tools after each sidecar call so the TTL garbage-collector
   * (T-155) does not reap workspaces an agent is actively working with.
   */
  async touch(id: string, sizeBytes?: number): Promise<void> {
    const patch: Record<string, unknown> = { lastActivityAt: new Date() };
    if (typeof sizeBytes === 'number' && sizeBytes >= 0) patch.sizeBytes = sizeBytes;
    await this.workspaceModel.updateOne({ _id: id }, { $set: patch }).exec();
  }

  /**
   * `touch` at most once per `TOUCH_THROTTLE_MS` and workspace. The IDE fires
   * many small file calls; one activity bump a minute is enough for the TTL
   * collector. Failures are swallowed (best-effort housekeeping).
   */
  touchThrottled(id: string): void {
    const now = Date.now();
    const last = this.lastTouch.get(id);
    if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
    this.lastTouch.set(id, now);
    this.touch(id).catch(() => undefined);
  }

  /**
   * Returns workspaces in `status` whose `lastActivityAt` is older than
   * `threshold`. Used by the TTL garbage-collector to pick candidates for
   * archive/delete. Sorted oldest-first so logs stay deterministic. SSH
   * workspaces are never candidates (their directory is not ours to reap);
   * `$ne` also keeps legacy documents without a `location`.
   */
  async findInactive(status: WorkspaceStatus, threshold: Date): Promise<WorkspaceDocument[]> {
    return this.workspaceModel
      .find({ status, location: { $ne: 'ssh' }, lastActivityAt: { $lt: threshold } })
      .sort({ lastActivityAt: 1 })
      .exec();
  }

  private emit(ws: WorkspaceDocument, action: 'created' | 'updated' | 'deleted', summary: string) {
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: ws.projectId.toString(),
      entity: 'workspace',
      action,
      entityId: ws._id.toString(),
      summary,
    });
  }
}
