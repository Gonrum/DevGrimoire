import { Module } from '@nestjs/common';
import { McpMetaController } from './mcp-meta.controller';

@Module({
  controllers: [McpMetaController],
})
export class McpMetaModule {}
