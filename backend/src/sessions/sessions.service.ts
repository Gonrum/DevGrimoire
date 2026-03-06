import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session, SessionDocument } from './schemas/session.schema';
import { CreateSessionDto } from './dto/create-session.dto';

@Injectable()
export class SessionsService {
  constructor(
    @InjectModel(Session.name) private sessionModel: Model<SessionDocument>,
  ) {}

  async create(dto: CreateSessionDto): Promise<SessionDocument> {
    return this.sessionModel.create(dto);
  }

  async findByProject(
    projectId: string,
    limit = 10,
  ): Promise<SessionDocument[]> {
    return this.sessionModel
      .find({ projectId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async findLatest(projectId: string): Promise<SessionDocument | null> {
    return this.sessionModel
      .findOne({ projectId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<SessionDocument> {
    const session = await this.sessionModel.findById(id).exec();
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    return session;
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.sessionModel.deleteMany({ projectId }).exec();
  }
}
