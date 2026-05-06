import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Environment, EnvironmentDocument } from './schemas/environment.schema';
import { CreateEnvironmentDto } from './dto/create-environment.dto';
import { UpdateEnvironmentDto } from './dto/update-environment.dto';
import { CustomersService } from '../customers/customers.service';
import { projectIdFilter } from '../common/project-id-filter';

@Injectable()
export class EnvironmentsService {
  constructor(
    @InjectModel(Environment.name) private envModel: Model<EnvironmentDocument>,
    private customersService: CustomersService,
  ) {}

  async create(dto: CreateEnvironmentDto): Promise<EnvironmentDocument> {
    if (!dto.projectId && !dto.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    if (dto.customerId) {
      await this.customersService.findById(dto.customerId);
    }
    return this.envModel.create(dto);
  }

  async findByProject(projectId: string): Promise<EnvironmentDocument[]> {
    return this.envModel.find({ projectId: projectIdFilter(projectId) }).sort({ name: 1 }).exec();
  }

  async findByCustomer(customerId: string): Promise<EnvironmentDocument[]> {
    return this.envModel.find({ customerId: projectIdFilter(customerId) }).sort({ name: 1 }).exec();
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

  async removeByCustomer(customerId: string): Promise<void> {
    await this.envModel.deleteMany({ customerId }).exec();
  }
}
