import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { Readable } from 'stream';
import { HttpRequestsService } from './http-requests.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { CreateRequestDto } from './dto/create-request.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { SendRequestDto } from './dto/send-request.dto';
import { ParseCurlDto } from './dto/parse-curl.dto';
import { Public } from '../auth/decorators/public.decorator';
import { DownloadTicketService } from './download-ticket.service';
import { DownloadTicketDto } from './dto/download-ticket.dto';

@Controller()
export class HttpRequestsController {
  constructor(
    private readonly svc: HttpRequestsService,
    private readonly tickets: DownloadTicketService,
  ) {}

  // ---- Collections ----
  @Get('projects/:projectId/request-collections')
  listCollections(@Param('projectId') projectId: string) {
    return this.svc.listCollections(projectId);
  }

  @Post('projects/:projectId/request-collections')
  @HttpCode(201)
  createCollection(@Param('projectId') projectId: string, @Body() dto: CreateCollectionDto) {
    return this.svc.createCollection({ ...dto, projectId });
  }

  @Patch('request-collections/:id')
  updateCollection(@Param('id') id: string, @Body() dto: UpdateCollectionDto) {
    return this.svc.updateCollection(id, dto);
  }

  @Delete('request-collections/:id')
  @HttpCode(204)
  deleteCollection(@Param('id') id: string) {
    return this.svc.deleteCollection(id);
  }

  // ---- Requests ----
  @Get('projects/:projectId/requests')
  listRequestsByProject(@Param('projectId') projectId: string) {
    return this.svc.listRequests({ projectId });
  }

  @Get('request-collections/:collectionId/requests')
  listRequests(@Param('collectionId') collectionId: string) {
    return this.svc.listRequests({ collectionId });
  }

  @Post('request-collections/:collectionId/requests')
  @HttpCode(201)
  createRequest(@Param('collectionId') collectionId: string, @Body() dto: CreateRequestDto) {
    return this.svc.createRequest({ ...dto, collectionId });
  }

  @Get('requests/:id')
  getRequest(@Param('id') id: string) {
    return this.svc.getRequest(id);
  }

  @Patch('requests/:id')
  updateRequest(@Param('id') id: string, @Body() dto: UpdateRequestDto) {
    return this.svc.updateRequest(id, dto);
  }

  @Delete('requests/:id')
  @HttpCode(204)
  deleteRequest(@Param('id') id: string) {
    return this.svc.deleteRequest(id);
  }

  // ---- Send ----
  @Post('requests/:id/send')
  send(@Param('id') id: string, @Body() dto: SendRequestDto) {
    return this.svc.send(id, dto);
  }

  // ---- History ----
  @Get('requests/:id/history')
  history(@Param('id') id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.listHistory(id, limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  @Get('request-history/:id')
  historyEntry(@Param('id') id: string) {
    return this.svc.getHistoryEntry(id);
  }

  // ---- curl ----
  @Post('http-requests/parse-curl')
  @HttpCode(200)
  parseCurl(@Body() dto: ParseCurlDto) {
    return this.svc.parseCurl(dto.curl);
  }

  // ---- Streaming-Download ----
  @Post('requests/:id/download-ticket')
  @HttpCode(200)
  async downloadTicket(@Param('id') id: string, @Body() dto: DownloadTicketDto, @Req() req: any) {
    await this.svc.getRequest(id); // Existenz/Scope-Check
    const userId = req.user?.userId ?? 'anonymous';
    const ticket = this.tickets.mint({ requestId: id, environmentId: dto.environmentId, userId });
    return { ticket, url: `/api/requests/${id}/download?ticket=${encodeURIComponent(ticket)}` };
  }

  @Public()
  @Get('requests/:id/download')
  async download(@Param('id') id: string, @Query('ticket') ticket: string, @Res() res: Response) {
    // Wirft UnauthorizedException (→ 401 via Exception-Filter) bei ungültig/abgelaufen/verbraucht.
    const { environmentId } = this.tickets.verifyAndConsume(ticket, id);
    try {
      const { upstream, filename } = await this.svc.openStream(id, { environmentId });
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (!upstream.body) { res.end(); return; }
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ message: 'Upstream nicht erreichbar: ' + (err as Error).message });
      } else {
        res.end();
      }
    }
  }
}
