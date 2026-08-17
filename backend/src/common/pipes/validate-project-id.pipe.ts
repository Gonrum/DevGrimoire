import { PipeTransform, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectsService } from '../../projects/projects.service';

@Injectable()
export class ValidateProjectIdPipe implements PipeTransform {
  constructor(private readonly projectsService: ProjectsService) {}

  /**
   * Generisch über den Wert, damit der DTO-Typ des Handlers erhalten bleibt.
   * Vorher `value: any` — die Pipe hat den Typ jedes DTOs, durch das sie lief,
   * auf `any` zurückgesetzt und damit die Typisierung im Controller entwertet.
   */
  async transform<T>(value: T): Promise<T> {
    const projectId = this.readProjectId(value);
    if (projectId) {
      try {
        await this.projectsService.findById(projectId);
      } catch {
        throw new NotFoundException(`Project ${projectId} not found`);
      }
    }
    return value;
  }

  private readProjectId(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const candidate = (value as { projectId?: unknown }).projectId;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  }
}
