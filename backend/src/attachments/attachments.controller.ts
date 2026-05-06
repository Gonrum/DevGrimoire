import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';
import { MinioService } from '../minio/minio.service';

const MAX_FILE_SIZE = parseInt(process.env.MINIO_MAX_FILE_SIZE || String(50 * 1024 * 1024), 10);

@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly minioService: MinioService,
  ) {}

  @Get('storage-status')
  storageStatus() {
    return {
      enabled: this.minioService.isEnabled(),
      ...(this.minioService.isEnabled()
        ? { bucket: process.env.MINIO_BUCKET || 'devgrimoire' }
        : {}),
    };
  }

  @Post()
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
    }),
  )
  async upload(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string },
    @Body('projectId') projectId?: string,
    @Body('customerId') customerId?: string,
    @Body('entityType') entityType?: string,
    @Body('entityId') entityId?: string,
    @Body('description') description?: string,
    @Body('tags') tagsRaw?: string,
  ) {
    if (!this.minioService.isEnabled()) {
      throw new ServiceUnavailableException('File storage not configured');
    }
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }

    const tags = tagsRaw
      ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    return this.attachmentsService.create(
      { projectId, customerId, entityType, entityId, description, tags },
      file,
    );
  }

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
  ) {
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    return customerId
      ? this.attachmentsService.findByCustomer(customerId, entityType, entityId)
      : this.attachmentsService.findByProject(projectId!, entityType, entityId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.attachmentsService.findById(id);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { stream, attachment } = await this.attachmentsService.download(id);
    const safeName = attachment.originalName.replace(/"/g, '\\"');
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', attachment.size);
    stream.pipe(res);
  }

  @Get(':id/preview')
  async preview(@Param('id') id: string, @Res() res: Response) {
    const { stream, attachment } = await this.attachmentsService.download(id);
    const safeName = attachment.originalName.replace(/"/g, '\\"');
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Content-Length', attachment.size);
    stream.pipe(res);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAttachmentDto) {
    return this.attachmentsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.attachmentsService.remove(id);
  }
}
