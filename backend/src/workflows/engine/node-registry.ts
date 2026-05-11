import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NodeExecutor } from './types';

@Injectable()
export class NodeRegistry {
  private readonly logger = new Logger(NodeRegistry.name);
  private readonly executors = new Map<string, NodeExecutor>();

  register(executor: NodeExecutor): void {
    if (this.executors.has(executor.type)) {
      this.logger.warn(`Overwriting executor for type "${executor.type}"`);
    }
    this.executors.set(executor.type, executor);
  }

  get(type: string): NodeExecutor {
    const exec = this.executors.get(type);
    if (!exec) {
      throw new NotFoundException(`No executor registered for node type "${type}"`);
    }
    return exec;
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  list(): string[] {
    return [...this.executors.keys()].sort();
  }

  getMetadata(type: string) {
    return this.get(type).metadata;
  }

  listMetadata() {
    return [...this.executors.values()].map((e) => e.metadata);
  }
}
