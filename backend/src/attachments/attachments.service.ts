import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { errorMessage, streamToBuffer } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
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
  ) {}

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
    if (!fields.projectId && !fields.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (fields.projectId && fields.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    if (fields.customerId) {
      await this.customersService.findById(fields.customerId);
    }

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
    const filter: Record<string, unknown> = { customerId: projectIdFilter(customerId) };
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    return this.attachmentModel
      .find(filter)
      .select('-textContent')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<AttachmentDocument> {
    const attachment = await this.attachmentModel.findById(id).select('-textContent').exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    const actor = RequestContext.getUser();
    if (actor) {
      const projectId = attachment.projectId?.toString() || null;
      const customerId = attachment.customerId?.toString() || null;
      const projectOk = !projectId || actorCanAccessProject(actor, projectId);
      const customerOk = !customerId || actorCanAccessCustomer(actor, customerId);
      if (!projectOk || !customerOk) {
        throw new ForbiddenException(`Attachment ${id} is not in your scope`);
      }
    }
    return attachment;
  }

  async update(id: string, dto: UpdateAttachmentDto): Promise<AttachmentDocument> {
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
    const attachment = await this.attachmentModel.findById(id).select('-textContent').exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    const stream = await this.minioService.getObject(attachment.storageKey);
    return { stream, attachment };
  }

  async getContent(id: string): Promise<{ buffer: Buffer; attachment: AttachmentDocument }> {
    const attachment = await this.attachmentModel.findById(id).select('-textContent').exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    const stream = await this.minioService.getObject(attachment.storageKey);
    return { buffer: await streamToBuffer(stream), attachment };
  }

  /**
   * Return the extracted text content of an attachment, or null if extraction
   * never produced any (binary file, extraction in flight, or extraction failed).
   * Used by the chat module to inject file contents into prompt context.
   */
  async getText(id: string): Promise<{ text: string | null; attachment: AttachmentDocument }> {
    const attachment = await this.attachmentModel.findById(id).exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    const raw = attachment.textContent;
    return { text: raw && raw.length > 0 ? raw : null, attachment };
  }

  async remove(id: string): Promise<void> {
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
    const attachments = await this.attachmentModel.find({ projectId }).exec();
    if (attachments.length === 0) return;
    const keys = attachments.map((a) => a.storageKey);
    await this.minioService.removeObjects(keys).catch((err) =>
      this.logger.warn(`MinIO batch delete failed: ${errorMessage(err)}`),
    );
    await this.attachmentModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
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
