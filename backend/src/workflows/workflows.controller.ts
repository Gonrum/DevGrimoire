import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngineService } from './engine/workflow-engine.service';
import { NodeRegistry } from './engine/node-registry';
import { toPublicMetadata, NodeMetadataPublic } from './engine/node-metadata';
import {
  CancelWorkflowRunDto,
  CreateWorkflowDefinitionDto,
  InstantiateWorkflowTemplateDto,
  ListWorkflowDefinitionsDto,
  ListWorkflowRunsDto,
  RetryWorkflowRunDto,
  StartWorkflowRunDto,
  TestWorkflowNodeDto,
  UpdateWorkflowDefinitionDto,
} from './dto/workflow.dto';

@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly engine: WorkflowEngineService,
    private readonly registry: NodeRegistry,
  ) {}

  @Post()
  @HttpCode(201)
  createDefinition(@Body() dto: CreateWorkflowDefinitionDto) {
    return this.workflows.createDefinition(dto);
  }

  @Get()
  listDefinitions(@Query() query: ListWorkflowDefinitionsDto) {
    return this.workflows.listDefinitions(query);
  }

  @Get('node-types')
  listNodeTypes(): NodeMetadataPublic[] {
    return this.registry.listMetadata().map(toPublicMetadata);
  }

  @Get('templates')
  listTemplates() {
    return this.workflows.listTemplates();
  }

  @Post('templates/instantiate')
  @HttpCode(201)
  instantiateTemplate(@Body() dto: InstantiateWorkflowTemplateDto) {
    return this.workflows.instantiateTemplate({
      templateId: dto.templateId,
      name: dto.name,
      scope: dto.scope,
      projectId: dto.projectId,
      customerId: dto.customerId,
    });
  }

  @Get(':id')
  getDefinition(@Param('id') id: string) {
    return this.workflows.getDefinition(id);
  }

  @Put(':id')
  updateDefinition(@Param('id') id: string, @Body() dto: UpdateWorkflowDefinitionDto) {
    return this.workflows.updateDefinition(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  deleteDefinition(@Param('id') id: string) {
    return this.workflows.deleteDefinition(id);
  }

  @Post('runs')
  @HttpCode(201)
  startRun(@Body() dto: StartWorkflowRunDto) {
    return this.workflows.startRun(dto);
  }

  @Post('nodes/test')
  testNode(@Body() dto: TestWorkflowNodeDto) {
    return this.engine.testNode(dto);
  }

  @Get('runs/list')
  listRuns(@Query() query: ListWorkflowRunsDto) {
    return this.workflows.listRuns(query);
  }

  @Get('runs/:id/inspection')
  inspectRun(@Param('id') id: string) {
    return this.workflows.inspectRun(id);
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.workflows.getRun(id);
  }

  @Post('runs/:id/cancel')
  cancelRun(@Param('id') id: string, @Body() dto: CancelWorkflowRunDto) {
    return this.workflows.cancelRun(id, dto);
  }

  @Post('runs/:id/retry')
  async retryRun(
    @Param('id') id: string,
    @Body() body: RetryWorkflowRunDto = {},
  ): Promise<{ ok: true; runId: string; parentRunId: string }> {
    const child = await this.engine.retryRun(id, body.fromNodeId);
    return {
      ok: true,
      runId: child._id.toString(),
      parentRunId: id,
    };
  }

  @Get('runs/:id/node-runs')
  listNodeRuns(@Param('id') id: string) {
    return this.workflows.listNodeRuns(id);
  }

  @Get('node-runs/:id')
  getNodeRun(@Param('id') id: string) {
    return this.workflows.getNodeRun(id);
  }
}
