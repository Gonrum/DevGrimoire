import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Workspace, WorkspaceDocument, WorkspaceStatus } from './schemas/workspace.schema';
import { isDuplicateKeyError } from '../common/narrow';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @InjectModel(Workspace.name) private readonly workspaceModel: Model<WorkspaceDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateWorkspaceDto): Promise<WorkspaceDocument> {
    const _id = new Types.ObjectId();
    const path = `/workspaces/${_id.toHexString()}/`;
    try {
      const ws = await this.workspaceModel.create({
        _id,
        projectId: new Types.ObjectId(dto.projectId),
        name: dto.name,
        description: dto.description,
        repoUrl: dto.repoUrl,
        branch: dto.branch ?? 'main',
        path,
        status: 'active',
        sizeBytes: 0,
        lastActivityAt: new Date(),
        createdBySessionId: dto.createdBySessionId,
        gitRepoId: dto.gitRepoId,
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
    const query: Record<string, unknown> = { projectId: new Types.ObjectId(projectId) };
    if (status) query.status = status;
    return this.workspaceModel.find(query).sort({ lastActivityAt: -1 }).exec();
  }

  async findById(id: string): Promise<WorkspaceDocument> {
    const ws = await this.workspaceModel.findById(id).exec();
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    return ws;
  }

  async findByName(projectId: string, name: string): Promise<WorkspaceDocument> {
    const ws = await this.workspaceModel
      .findOne({ projectId: new Types.ObjectId(projectId), name })
      .exec();
    if (!ws) {
      throw new NotFoundException(`Workspace "${name}" not found in project ${projectId}`);
    }
    return ws;
  }

  async update(id: string, dto: UpdateWorkspaceDto): Promise<WorkspaceDocument> {
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

  async archive(id: string): Promise<WorkspaceDocument> {
    const ws = await this.workspaceModel
      .findByIdAndUpdate(id, { status: 'archived', lastActivityAt: new Date() }, { new: true })
      .exec();
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    this.emit(ws, 'updated', `Workspace "${ws.name}" archiviert`);
    return ws;
  }

  async remove(id: string): Promise<void> {
    const ws = await this.workspaceModel.findByIdAndDelete(id).exec();
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    this.emit(ws, 'deleted', `Workspace "${ws.name}" gelöscht`);
  }

  async removeByProject(projectId: string): Promise<void> {
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
   * Returns workspaces in `status` whose `lastActivityAt` is older than
   * `threshold`. Used by the TTL garbage-collector to pick candidates for
   * archive/delete. Sorted oldest-first so logs stay deterministic.
   */
  async findInactive(status: WorkspaceStatus, threshold: Date): Promise<WorkspaceDocument[]> {
    return this.workspaceModel
      .find({ status, lastActivityAt: { $lt: threshold } })
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
