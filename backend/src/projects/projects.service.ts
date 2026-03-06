import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Project, ProjectDocument } from './schemas/project.schema';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>,
  ) {}

  async create(dto: CreateProjectDto): Promise<ProjectDocument> {
    return this.projectModel.create(dto);
  }

  async findAll(active?: boolean): Promise<ProjectDocument[]> {
    const filter = active !== undefined ? { active } : {};
    return this.projectModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async findById(id: string): Promise<ProjectDocument> {
    const project = await this.projectModel.findById(id).exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async findByName(name: string): Promise<ProjectDocument | null> {
    return this.projectModel.findOne({ name }).exec();
  }

  async update(id: string, dto: UpdateProjectDto): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async remove(id: string): Promise<void> {
    const result = await this.projectModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Project ${id} not found`);
  }
}
