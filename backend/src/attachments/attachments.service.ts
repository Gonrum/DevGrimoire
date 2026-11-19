import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { errorMessage, streamToBuffer } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isValidObjectId, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { Attachment, AttachmentDocument } from './schemas/attachment.schema';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';
import { MinioService } from '../minio/minio.service';
import { CustomersService } from '../customers/customers.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { RequestContext } from '../common/request-context';
import {
  actorCanAccessCustomer,
  actorCanAccessProject,
} from '../common/permissions';
import { MAX_ATTACHMENT_SIZE, base64DecodedSize } from './attachment-limits';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { assertOwnerInScope, assertOwnerParamsInScope, assertOwnerPermission } from '../common/scope-guard';
import { Todo, TodoDocument } from '../todos/schemas/todo.schema';
import { Knowledge, KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';
import { Release, ReleaseDocument } from '../releases/schemas/release.schema';

/** Owner fields of an entity an attachment can be linked to. */
interface LinkTargetOwner {
  projectId?: Types.ObjectId | null;
  customerId?: Types.ObjectId | null;
}

/** Mimetypes treated as extractable text */
const TEXT_MIMETYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/css',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.html', '.css', '.xml', '.json',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.env', '.sql', '.graphql', '.svelte', '.vue', '.prisma',
]);

function isTextFile(mimeType: string, fileName: string): boolean {
  if (TEXT_MIMETYPES.has(mimeType)) return true;
  if (mimeType.startsWith('text/')) return true;
  const ext = fileName.lastIndexOf('.') >= 0 ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @InjectModel(Attachment.name)
    private attachmentModel: Model<AttachmentDocument>,
    private minioService: MinioService,
    private customersService: CustomersService,
    private eventEmitter: EventEmitter2,
    // Link targets (entityType/entityId). Models instead of the services:
    // TodosModule already imports CustomersModule, so a service dependency
    // would add a module cycle for a plain owner lookup.
    @InjectModel(Todo.name) private todoModel?: Model<TodoDocument>,
    @InjectModel(Knowledge.name) private knowledgeModel?: Model<KnowledgeDocument>,
    @InjectModel(Release.name) private releaseModel?: Model<ReleaseDocument>,
  ) {}

  /**
   * Validates the entity an attachment is linked to. Without this a caller
   * could attach a file in its own project to a todo of a foreign project
   * (entityType="todo", entityId=<foreign id>): the file would then surface
   * in that todo's attachment list and be removed by its cascade.
   *
   * The target must exist, belong to the SAME owner as the attachment and be
   * in the actor's scope. Missing and foreign targets get the same 400 so the
   * check is not an existence oracle for foreign ids. Unknown entity types
   * with an entityId are rejected (fail closed) — nothing could validate them.
   */
  private async assertLinkTarget(
    owner: { projectId?: string | null; customerId?: string | null },
    entityType: string | undefined,
    entityId: string | undefined,
  ): Promise<void> {
    if (!entityId) return;
    if (!entityType) {
      throw new BadRequestException('entityType is required when entityId is set');
    }
    if (!isValidObjectId(entityId)) {
      throw new BadRequestException('entityId must be a valid id');
    }
    const objectId = new Types.ObjectId(entityId);
    let target: LinkTargetOwner | null;
    if (entityType === 'todo' && this.todoModel) {
      target = await this.todoModel.findById(objectId).select('projectId customerId').lean().exec();
    } else if (entityType === 'knowledge' && this.knowledgeModel) {
      target = await this.knowledgeModel.findById(objectId).select('projectId customerId').lean().exec();
    } else if (entityType === 'release' && this.releaseModel) {
      // Release artifacts saved from a workspace (`workspace_attachment_save`).
      target = await this.releaseModel.findById(objectId).select('projectId').lean().exec();
    } else {
      throw new BadRequestException(`Unsupported entityType "${entityType}"`);
    }
    const targetProject = target?.projectId?.toString() ?? null;
    const targetCustomer = target?.customerId?.toString() ?? null;
    const sameOwner = owner.projectId
      ? targetProject === owner.projectId
      : !!owner.customerId && targetCustomer === owner.customerId;
    if (!target || !sameOwner) {
      throw new BadRequestException(`${entityType} ${entityId} not found for this attachment's owner`);
    }
    // A todo may carry a second axis (project todo for a customer); both must
    // be in scope, not only the one shared with the attachment.
    assertOwnerInScope({ projectId: target.projectId, customerId: target.customerId }, `${entityType} ${entityId}`);
  }

  async create(
    fields: {
      projectId?: string;
      customerId?: string;
      entityType?: string;
      entityId?: string;
      description?: string;
      tags?: string[];
    },
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<AttachmentDocument> {
    if (file.buffer.length > MAX_ATTACHMENT_SIZE) {
      throw new PayloadTooLargeException(
        `Datei zu gross: ${file.buffer.length} Bytes, erlaubt sind ${MAX_ATTACHMENT_SIZE} (MINIO_MAX_FILE_SIZE)`,
      );
    }
    if (!fields.projectId && !fields.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (fields.projectId && fields.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    // The owner id becomes part of the storage key — only real ObjectIds.
    if ((fields.projectId && !isValidObjectId(fields.projectId)) || (fields.customerId && !isValidObjectId(fields.customerId))) {
      throw new BadRequestException('projectId/customerId must be a valid id');
    }
    // BEFORE putObject: a narrowed actor must not store files (which are then
    // text-extracted into the RAG index) in a foreign project or customer.
    assertOwnerParamsInScope({ projectId: fields.projectId, customerId: fields.customerId });
    assertOwnerPermission({ projectId: fields.projectId, customerId: fields.customerId }, 'file', 'write');
    if (fields.customerId) {
      await this.customersService.findById(fields.customerId);
    }
    // Also before putObject: no orphaned MinIO object on a rejected link.
    await this.assertLinkTarget(fields, fields.entityType || undefined, fields.entityId || undefined);

    const uuid = randomUUID();
    const safeName = sanitizeFilename(file.originalname);
    const ownerSegment = fields.projectId
      ? fields.projectId
      : `customers/${fields.customerId}`;
    const storageKey = `${ownerSegment}/${uuid}_${safeName}`;

    await this.minioService.putObject(storageKey, file.buffer, file.mimetype);

    const attachment = await this.attachmentModel.create({
      projectId: fields.projectId,
      customerId: fields.customerId,
      entityType: fields.entityType || undefined,
      entityId: fields.entityId || undefined,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.buffer.length,
      storageKey,
      description: fields.description,
      tags: fields.tags || [],
      ragIndexed: false,
    });

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: fields.projectId ?? null,
      customerId: fields.customerId ?? null,
      entity: 'attachment',
      action: 'created',
      entityId: attachment._id.toString(),
      summary: `Datei "${file.originalname}" hochgeladen`,
    });

    // Async text extraction — don't await
    this.extractAndStoreText(attachment, file.buffer).catch((err) =>
      this.logger.warn(`Text extraction failed for ${file.originalname}: ${errorMessage(err)}`),
    );

    return attachment;
  }

  async findByProject(
    projectId: string,
    entityType?: string,
    entityId?: string,
  ): Promise<AttachmentDocument[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessProject(actor, projectId)) {
      throw new ForbiddenException(`Project ${projectId} is not in your scope`);
    }
    assertOwnerPermission({ projectId }, 'file', 'read');
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    return this.attachmentModel
      .find(filter)
      .select('-textContent')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findByCustomer(
    customerId: string,
    entityType?: string,
    entityId?: string,
  ): Promise<AttachmentDocument[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessCustomer(actor, customerId)) {
      throw new ForbiddenException(`Customer ${customerId} is not in your scope`);
    }
    assertOwnerPermission({ customerId }, 'file', 'read');
    const filter: Record<string, unknown> = { customerId: projectIdFilter(customerId) };
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    return this.attachmentModel
      .find(filter)
      .select('-textContent')
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Projekt-/Kunden-Scope-Prüfung für ein Attachment-Dokument (T-210/T-220).
   *
   * Stand vorher AUSSCHLIESSLICH in findById(). Die Schreib- und Download-Pfade
   * (update, download, getContent, getText, remove) gingen direkt aufs Modell —
   * damit waren die Metadaten geschützt, die DATEIBYTES aber nicht:
   * GET /api/attachments/:id/download lieferte jeden Anhang aus jedem Projekt
   * (Verträge, Zertifikate, .env-Exporte), und DELETE löschte ihn samt
   * MinIO-Objekt unwiederbringlich. getText() war derselbe Fall für den
   * extrahierten Volltext.
   *
   * `if (actor)` statt fail-closed ist die dokumentierte Konvention dieses
   * Projekts (SecretsService, KubeClustersService, http-requests): JwtAuthGuard
   * hängt global, jeder echte HTTP-Aufruf hat einen Actor; ein fehlender Actor
   * ist ein vertrauenswürdiger interner Aufrufer (Replikation, Migration,
   * stdio-MCP ohne HTTP-Kontext).
   */
  private assertAccess(attachment: AttachmentDocument, action: 'read' | 'write' = 'read'): void {
    const actor = RequestContext.getUser();
    if (!actor) return;
    assertOwnerPermission(attachment, 'file', action);
    const projectId = attachment.projectId?.toString() || null;
    const customerId = attachment.customerId?.toString() || null;
    const projectOk = !projectId || actorCanAccessProject(actor, projectId);
    const customerOk = !customerId || actorCanAccessCustomer(actor, customerId);
    if (!projectOk || !customerOk) {
      throw new ForbiddenException(`Attachment ${attachment._id.toString()} is not in your scope`);
    }
  }

  /**
   * Lädt ein Attachment, prüft 404 und den Scope — die eine Stelle, die jeder
   * Pfad benutzt, damit eine neue Methode die Prüfung nicht vergessen kann.
   * `withText` nur für getText(): alle anderen Pfade brauchen den extrahierten
   * Volltext nicht und schleppen ihn sonst unnötig durch den Speicher.
   */
  private async findScoped(
    id: string,
    withText = false,
    action: 'read' | 'write' = 'read',
  ): Promise<AttachmentDocument> {
    const query = this.attachmentModel.findById(id);
    const attachment = await (withText ? query : query.select('-textContent')).exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    this.assertAccess(attachment, action);
    return attachment;
  }

  async findById(id: string): Promise<AttachmentDocument> {
    return this.findScoped(id);
  }

  async update(id: string, dto: UpdateAttachmentDto): Promise<AttachmentDocument> {
    // VOR der Mutation prüfen: findByIdAndUpdate hätte sonst schon geschrieben.
    const existing = await this.findScoped(id, false, 'write');
    // Validate the resulting link (existing values merged with the change),
    // so changing only entityId re-targets against the stored entityType.
    if (dto.entityType !== undefined || dto.entityId !== undefined) {
      await this.assertLinkTarget(
        {
          projectId: existing.projectId?.toString() ?? null,
          customerId: existing.customerId?.toString() ?? null,
        },
        dto.entityType ?? existing.entityType ?? undefined,
        dto.entityId ?? existing.entityId?.toString() ?? undefined,
      );
    }
    const attachment = await this.attachmentModel
      .findByIdAndUpdate(id, dto, { new: true })
      .select('-textContent')
      .exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: attachment.projectId?.toString() ?? null,
      customerId: attachment.customerId?.toString() ?? null,
      entity: 'attachment',
      action: 'updated',
      entityId: id,
      summary: `Datei "${attachment.originalName}" aktualisiert`,
    });
    return attachment;
  }

  async download(id: string): Promise<{ stream: Readable; attachment: AttachmentDocument }> {
    const attachment = await this.findScoped(id);
    const stream = await this.minioService.getObject(attachment.storageKey);
    return { stream, attachment };
  }

  async getContent(id: string): Promise<{ buffer: Buffer; attachment: AttachmentDocument }> {
    const attachment = await this.findScoped(id);
    const stream = await this.minioService.getObject(attachment.storageKey);
    return { buffer: await streamToBuffer(stream), attachment };
  }

  /**
   * Return the extracted text content of an attachment, or null if extraction
   * never produced any (binary file, extraction in flight, or extraction failed).
   * Used by the chat module to inject file contents into prompt context.
   */
  async getText(id: string): Promise<{ text: string | null; attachment: AttachmentDocument }> {
    const attachment = await this.findScoped(id, true);
    const raw = attachment.textContent;
    return { text: raw && raw.length > 0 ? raw : null, attachment };
  }

  async remove(id: string): Promise<void> {
    // VOR findByIdAndDelete prüfen — die Methode löscht sonst erst und liefert
    // dann das gelöschte Dokument, und die MinIO-Kaskade ist unwiederbringlich.
    await this.findScoped(id, false, 'write');
    const attachment = await this.attachmentModel.findByIdAndDelete(id).exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    await this.minioService.removeObject(attachment.storageKey).catch((err) =>
      this.logger.warn(`MinIO delete failed for ${attachment.storageKey}: ${errorMessage(err)}`),
    );
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: attachment.projectId?.toString() ?? null,
      customerId: attachment.customerId?.toString() ?? null,
      entity: 'attachment',
      action: 'deleted',
      entityId: id,
      summary: `Datei "${attachment.originalName}" gelöscht`,
    });
  }

  async removeByEntity(entityType: string, entityId: string): Promise<void> {
    const attachments = await this.attachmentModel.find({ entityType, entityId }).exec();
    if (attachments.length === 0) return;
    const keys = attachments.map((a) => a.storageKey);
    await this.minioService.removeObjects(keys).catch((err) =>
      this.logger.warn(`MinIO batch delete failed: ${errorMessage(err)}`),
    );
    await this.attachmentModel.deleteMany({ entityType, entityId }).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    const attachments = await this.attachmentModel.find({ projectId }).exec();
    if (attachments.length === 0) return;
    const keys = attachments.map((a) => a.storageKey);
    await this.minioService.removeObjects(keys).catch((err) =>
      this.logger.warn(`MinIO batch delete failed: ${errorMessage(err)}`),
    );
    await this.attachmentModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    const attachments = await this.attachmentModel.find({ customerId }).exec();
    if (attachments.length === 0) return;
    const keys = attachments.map((a) => a.storageKey);
    await this.minioService.removeObjects(keys).catch((err) =>
      this.logger.warn(`MinIO batch delete failed: ${errorMessage(err)}`),
    );
    await this.attachmentModel.deleteMany({ customerId }).exec();
  }

  /** Upload from base64 content (used by MCP tools) */
  async createFromBase64(
    fields: {
      projectId?: string;
      customerId?: string;
      fileName: string;
      mimeType?: string;
      entityType?: string;
      entityId?: string;
      description?: string;
      tags?: string[];
    },
    base64Content: string,
  ): Promise<AttachmentDocument> {
    // Scope first, so a foreign upload is not even decoded; create() checks again.
    assertOwnerParamsInScope({ projectId: fields.projectId, customerId: fields.customerId });
    assertOwnerPermission({ projectId: fields.projectId, customerId: fields.customerId }, 'file', 'write');
    // VOR dem Decodieren prüfen — sonst läge der übergrosse Buffer schon im
    // Speicher, bevor create() ihn ablehnt.
    const decodedSize = base64DecodedSize(base64Content);
    if (decodedSize > MAX_ATTACHMENT_SIZE) {
      throw new PayloadTooLargeException(
        `Datei zu gross: ${decodedSize} Bytes, erlaubt sind ${MAX_ATTACHMENT_SIZE} (MINIO_MAX_FILE_SIZE)`,
      );
    }
    const buffer = Buffer.from(base64Content, 'base64');
    const mimeType = fields.mimeType || this.guessMimeType(fields.fileName);
    return this.create(
      {
        projectId: fields.projectId,
        customerId: fields.customerId,
        entityType: fields.entityType,
        entityId: fields.entityId,
        description: fields.description,
        tags: fields.tags,
      },
      { buffer, originalname: fields.fileName, mimetype: mimeType },
    );
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.lastIndexOf('.') >= 0 ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
    const map: Record<string, string> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.js': 'application/javascript', '.ts': 'application/typescript',
      '.html': 'text/html', '.css': 'text/css', '.xml': 'application/xml',
      '.csv': 'text/csv', '.pdf': 'application/pdf',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.zip': 'application/zip', '.tar': 'application/x-tar',
      '.gz': 'application/gzip', '.py': 'text/x-python',
      '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
      '.sh': 'application/x-sh', '.sql': 'text/x-sql',
    };
    return map[ext] || 'application/octet-stream';
  }

  private async extractAndStoreText(
    attachment: AttachmentDocument,
    buffer: Buffer,
  ): Promise<void> {
    let textContent: string | null = null;

    if (isTextFile(attachment.mimeType, attachment.originalName)) {
      textContent = buffer.toString('utf-8');
    } else if (attachment.mimeType === 'application/pdf') {
      try {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        const result = await parser.getText();
        textContent = result.text;
        await parser.destroy();
      } catch (err) {
        this.logger.warn(`PDF parsing failed for ${attachment.originalName}: ${errorMessage(err)}`);
      }
    }

    if (textContent && textContent.trim().length > 0) {
      await this.attachmentModel.findByIdAndUpdate(attachment._id, {
        textContent,
        ragIndexed: true,
      });
      // Re-emit so RAG picks up the text content
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: attachment.projectId?.toString() ?? null,
        customerId: attachment.customerId?.toString() ?? null,
        entity: 'attachment',
        action: 'updated',
        entityId: attachment._id.toString(),
      });
    }
  }
}
