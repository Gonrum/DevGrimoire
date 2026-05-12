import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CreateKgEdgeDto, GraphQueryDto, ListKgEdgesDto } from './dto/knowledge-graph.dto';
import { KnowledgeGraphService } from './knowledge-graph.service';

@Controller('knowledge-graph')
export class KnowledgeGraphController {
  constructor(private readonly graph: KnowledgeGraphService) {}

  @Post('edges')
  @HttpCode(201)
  create(@Body() dto: CreateKgEdgeDto) {
    return this.graph.create(dto);
  }

  @Get('edges')
  list(@Query() query: ListKgEdgesDto) {
    return this.graph.list(query);
  }

  @Get('edges/:id')
  get(@Param('id') id: string) {
    return this.graph.findById(id);
  }

  @Delete('edges/:id')
  remove(@Param('id') id: string) {
    return this.graph.remove(id).then(() => ({ deleted: true, id }));
  }

  @Post('edges/:id/confirm')
  confirm(@Param('id') id: string, @Body() body: { confirmed?: boolean }) {
    return this.graph.confirm(id, body.confirmed !== false);
  }

  @Get('neighbors')
  neighbors(@Query() query: GraphQueryDto) {
    return this.graph.neighbors(query.projectId, query.entityType, query.entityId);
  }

  @Get('impact')
  impact(@Query() query: GraphQueryDto) {
    return this.graph.impact(query.projectId, query.entityType, query.entityId, query.depth);
  }

  @Post('discover/:projectId')
  discover(@Param('projectId') projectId: string) {
    return this.graph.discoverForProject(projectId);
  }
}
