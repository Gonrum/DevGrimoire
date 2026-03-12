import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProjectTransferService } from './project-transfer.service';

@Controller('project-transfer')
export class ProjectTransferController {
  constructor(private transferService: ProjectTransferService) {}

  @Get(':id/export')
  async exportProject(
    @Param('id') id: string,
    @Query('includeSecretValues') includeSecrets: string,
    @Res() res: Response,
  ) {
    const data = await this.transferService.exportProject(
      id,
      includeSecrets === 'true',
    );

    const safeName = (data.project.name as string || 'project')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}-export-${date}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importProject(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string },
    @Query('name') nameOverride?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    let data: any;
    try {
      data = JSON.parse(file.buffer.toString('utf-8'));
    } catch {
      throw new BadRequestException('Invalid JSON file');
    }

    return this.transferService.importProject(data, nameOverride);
  }
}
