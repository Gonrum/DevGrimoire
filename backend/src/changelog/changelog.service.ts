import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Changelog, ChangelogDocument } from './schemas/changelog.schema';
import { CreateChangelogDto } from './dto/create-changelog.dto';
import { UpdateChangelogDto } from './dto/update-changelog.dto';

@Injectable()
export class ChangelogService {
  constructor(
    @InjectModel(Changelog.name)
    private changelogModel: Model<ChangelogDocument>,
  ) {}

  async create(dto: CreateChangelogDto): Promise<ChangelogDocument> {
    return this.changelogModel.create(dto);
  }

  async findByProject(
    projectId: string,
    limit = 50,
  ): Promise<ChangelogDocument[]> {
    return this.changelogModel
      .find({ projectId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async findById(id: string): Promise<ChangelogDocument> {
    const entry = await this.changelogModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Changelog ${id} not found`);
    return entry;
  }

  async update(id: string, dto: UpdateChangelogDto): Promise<ChangelogDocument> {
    const entry = await this.changelogModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!entry) throw new NotFoundException(`Changelog ${id} not found`);
    return entry;
  }

  async remove(id: string): Promise<void> {
    const result = await this.changelogModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Changelog ${id} not found`);
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.changelogModel.deleteMany({ projectId }).exec();
  }
}
