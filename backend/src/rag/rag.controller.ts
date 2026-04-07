import { Controller, Get, Post, Query, HttpCode } from '@nestjs/common';
import { RagService } from './rag.service';

@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Get('search')
  async search(
    @Query('query') query: string,
    @Query('projectId') projectId?: string,
    @Query('entity') entity?: string,
    @Query('limit') limit?: string,
  ) {
    if (!query) throw new Error('Missing required query parameter: query');
    const results = await this.ragService.search(
      query,
      projectId || undefined,
      entity || undefined,
      limit ? parseInt(limit, 10) : 10,
    );
    return results;
  }

  @Post('reindex')
  @HttpCode(200)
  async reindex(@Query('projectId') projectId?: string) {
    return this.ragService.reindex(projectId || undefined);
  }

  @Get('status')
  async status(): Promise<Record<string, unknown>> {
    return this.ragService.status() as any;
  }
}
