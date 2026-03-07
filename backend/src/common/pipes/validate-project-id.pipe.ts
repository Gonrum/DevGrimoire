import { PipeTransform, Injectable, NotFoundException } from '@nestjs/common';
import { ProjectsService } from '../../projects/projects.service';

@Injectable()
export class ValidateProjectIdPipe implements PipeTransform {
  constructor(private readonly projectsService: ProjectsService) {}

  async transform(value: any) {
    if (value && value.projectId) {
      try {
        await this.projectsService.findById(value.projectId);
      } catch {
        throw new NotFoundException(`Project ${value.projectId} not found`);
      }
    }
    return value;
  }
}
