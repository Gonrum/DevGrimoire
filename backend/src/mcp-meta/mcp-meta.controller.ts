import { Controller, Get } from '@nestjs/common';
import { getToolCatalog, McpToolCatalogEntry } from '../mcp-tools';

@Controller('mcp')
export class McpMetaController {
  @Get('tools')
  listTools(): McpToolCatalogEntry[] {
    return getToolCatalog();
  }
}
