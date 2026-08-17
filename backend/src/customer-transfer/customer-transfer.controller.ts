import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { asString } from '../common/tool-args';
import { CustomerTransferService } from './customer-transfer.service';

@Controller('customer-transfer')
export class CustomerTransferController {
  constructor(private readonly transferService: CustomerTransferService) {}

  @Get(':id/export')
  async exportCustomer(
    @Param('id') id: string,
    @Query('includeSecretValues') includeSecretValues: string,
    @Res() res: Response,
  ) {
    const data = await this.transferService.exportCustomer(
      id,
      includeSecretValues === 'true',
    );

    // `customer` ist ein `Record<string, unknown>` — der Name ist erst dann ein
    // String, wenn er einer ist. Vorher hätte ein Nicht-String-Name die Antwort
    // mit einem TypeError beendet, statt auf 'customer' zurückzufallen.
    const safeName = (asString(data.customer.name) || 'customer').replace(/[^a-zA-Z0-9_-]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${safeName}-customer-export-${date}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importCustomer(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string },
    @Query('name') nameOverride?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    let data: unknown;
    try {
      data = JSON.parse(file.buffer.toString('utf-8'));
    } catch {
      throw new BadRequestException('Invalid JSON file');
    }
    return this.transferService.importCustomer(data, nameOverride);
  }
}
