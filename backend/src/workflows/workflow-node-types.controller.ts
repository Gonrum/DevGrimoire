import { Controller, Get } from '@nestjs/common';
import { NodeRegistry } from './engine/node-registry';
import { toPublicMetadata, NodeMetadataPublic } from './engine/node-metadata';

@Controller('workflow-node-types')
export class WorkflowNodeTypesController {
  constructor(private readonly registry: NodeRegistry) {}

  @Get()
  list(): NodeMetadataPublic[] {
    return this.registry.listMetadata().map(toPublicMetadata);
  }
}
