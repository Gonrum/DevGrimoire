import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { Attachment, AttachmentDocument } from './schemas/attachment.schema';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';
import { MinioService } from '../minio/minio.service';
import { PROJECT_CHANGED } from '../events/project-event';

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
    private eventEmitter: EventEmitter2,
  ) {}

  async create(
    fields: {
      projectId: string;
      entityType?: string;
      entityId?: string;
      description?: string;
      tags?: string[];
    },
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<AttachmentDocument> {
    const uuid = randomUUID();
    const safeName = sanitizeFilename(file.originalname);
    const storageKey = `${fields.projectId}/${uuid}_${safeName}`;

    await this.minioService.putObject(storageKey, file.buffer, file.mimetype);

    const attachment = await this.attachmentModel.create({
      projectId: fields.projectId,
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
      projectId: fields.projectId,
      entity: 'attachment',
      action: 'created',
      entityId: attachment._id.toString(),
      summary: `Datei "${file.originalname}" hochgeladen`,
    });

    // Async text extraction — don't await
    this.extractAndStoreText(attachment, file.buffer).catch((err) =>
      this.logger.warn(`Text extraction failed for ${file.originalname}: ${(err as Error).message}`),
    );

    return attachment;
  }

  async findByProject(
    projectId: string,
    entityType?: string,
    entityId?: string,
  ): Promise<AttachmentDocument[]> {
    const filter: Record<string, unknown> = { projectId };
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
    return attachment;
  }

  async update(id: string, dto: UpdateAttachmentDto): Promise<AttachmentDocument> {
    const attachment = await this.attachmentModel
      .findByIdAndUpdate(id, dto, { new: true })
      .select('-textContent')
      .exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: attachment.projectId.toString(),
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
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), attachment };
  }

  async remove(id: string): Promise<void> {
    const attachment = await this.attachmentModel.findByIdAndDelete(id).exec();
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    await this.minioService.removeObject(attachment.storageKey).catch((err) =>
      this.logger.warn(`MinIO delete failed for ${attachment.storageKey}: ${(err as Error).message}`),
    );
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: attachment.projectId.toString(),
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
      this.logger.warn(`MinIO batch delete failed: ${(err as Error).message}`),
    );
    await this.attachmentModel.deleteMany({ entityType, entityId }).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    const attachments = await this.attachmentModel.find({ projectId }).exec();
    if (attachments.length === 0) return;
    const keys = attachments.map((a) => a.storageKey);
    await this.minioService.removeObjects(keys).catch((err) =>
      this.logger.warn(`MinIO batch delete failed: ${(err as Error).message}`),
    );
    await this.attachmentModel.deleteMany({ projectId }).exec();
  }

  /** Upload from base64 content (used by MCP tools) */
  async createFromBase64(
    fields: {
      projectId: string;
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
        this.logger.warn(`PDF parsing failed for ${attachment.originalName}: ${(err as Error).message}`);
      }
    }

    if (textContent && textContent.trim().length > 0) {
      await this.attachmentModel.findByIdAndUpdate(attachment._id, {
        textContent,
        ragIndexed: true,
      });
      // Re-emit so RAG picks up the text content
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: attachment.projectId.toString(),
        entity: 'attachment',
        action: 'updated',
        entityId: attachment._id.toString(),
      });
    }
  }
}
