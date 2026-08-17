import { Body, Controller, Get, Put, Post, Query, HttpCode } from '@nestjs/common';
import { RagService, EmbeddingEndpointInput } from './rag.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';

@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Get('search')
  async search(
    @Query('query') query: string,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('entity') entity?: string,
    @Query('limit') limit?: string,
  ) {
    if (!query) throw new Error('Missing required query parameter: query');
    const results = await this.ragService.search(
      query,
      projectId || undefined,
      entity || undefined,
      limit ? parseInt(limit, 10) : 10,
      customerId || undefined,
    );
    return results;
  }

  @Post('reindex')
  @HttpCode(200)
  async reindex(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.ragService.reindex(projectId || undefined, customerId || undefined);
  }

  @Get('status')
  async status(): Promise<Record<string, unknown>> {
    return this.ragService.status();
  }

  @Get('config')
  async getConfig() {
    const [endpoints, managedViaSettings, status] = await Promise.all([
      this.ragService.getEndpointsPublic(),
      this.ragService.isManagedViaSettings(),
      this.ragService.status() as any,
    ]);
    return { endpoints, managedViaSettings, status };
  }

  @Put('config')
  @Roles(UserRole.ADMIN)
  async setConfig(@Body() dto: { endpoints: EmbeddingEndpointInput[] }) {
    await this.ragService.setEndpoints(dto.endpoints ?? []);
    return this.getConfig();
  }

  @Post('config/test')
  @HttpCode(200)
  async testConfig(@Body() dto: EmbeddingEndpointInput) {
    return this.ragService.testEndpoint(dto);
  }
}
