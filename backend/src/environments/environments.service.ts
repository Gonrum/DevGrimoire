import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Environment, EnvironmentDocument } from './schemas/environment.schema';
import { CreateEnvironmentDto } from './dto/create-environment.dto';
import { UpdateEnvironmentDto } from './dto/update-environment.dto';

@Injectable()
export class EnvironmentsService {
  constructor(
    @InjectModel(Environment.name) private envModel: Model<EnvironmentDocument>,
  ) {}

  async create(dto: CreateEnvironmentDto): Promise<EnvironmentDocument> {
    return this.envModel.create(dto);
  }

  async findByProject(projectId: string): Promise<EnvironmentDocument[]> {
    return this.envModel.find({ projectId }).sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<EnvironmentDocument> {
    const env = await this.envModel.findById(id).exec();
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  async update(id: string, dto: UpdateEnvironmentDto): Promise<EnvironmentDocument> {
    const env = await this.envModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  async delete(id: string): Promise<void> {
    const result = await this.envModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Environment not found');
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.envModel.deleteMany({ projectId }).exec();
  }
}
