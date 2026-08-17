import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Note, NoteDocument } from './schemas/note.schema';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';

const IDLE_THRESHOLD_DAYS = 5;
const IDLE_THRESHOLD_MS = IDLE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

export interface NoteWithIdle {
  _id: string;
  userId: string;
  title: string;
  content: string;
  order: number;
  archived: boolean;
  archivedAt?: Date;
  promotedTo?: {
    entityType: string;
    entityId: string;
    projectId?: string;
    customerId?: string;
  };
  idleSnoozeUntil?: Date;
  promotionAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  isIdle: boolean;
}

@Injectable()
export class NotesService {
  constructor(@InjectModel(Note.name) private readonly noteModel: Model<NoteDocument>) {}

  // ---------- queries ----------

  async listActive(userId: string): Promise<NoteWithIdle[]> {
    const docs = await this.noteModel
      .find({ userId: new Types.ObjectId(userId), archived: false })
      .sort({ order: 1, createdAt: 1 })
      .lean()
      .exec();
    return docs.map((d) => this.withIdle(d));
  }

  async listArchived(userId: string): Promise<NoteWithIdle[]> {
    const docs = await this.noteModel
      .find({ userId: new Types.ObjectId(userId), archived: true })
      .sort({ archivedAt: -1 })
      .lean()
      .exec();
    return docs.map((d) => this.withIdle(d));
  }

  async findOne(userId: string, id: string): Promise<NoteDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Note not found');
    }
    const doc = await this.noteModel
      .findOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
      .exec();
    if (!doc) throw new NotFoundException('Note not found');
    return doc;
  }

  // ---------- mutations ----------

  async create(userId: string, dto: CreateNoteDto): Promise<NoteWithIdle> {
    const userObjectId = new Types.ObjectId(userId);
    const [{ maxOrder = -1 } = { maxOrder: -1 }] = await this.noteModel
      .aggregate<{ maxOrder: number }>([
        { $match: { userId: userObjectId, archived: false } },
        { $group: { _id: null, maxOrder: { $max: '$order' } } },
      ])
      .exec();

    const count = await this.noteModel
      .countDocuments({ userId: userObjectId })
      .exec();

    const title = dto.title?.trim() || `Notiz ${count + 1}`;
    const content = dto.content ?? '';
    const created = await this.noteModel.create({
      userId: userObjectId,
      title,
      content,
      order: maxOrder + 1,
    });
    return this.withIdle(created.toObject());
  }

  async update(userId: string, id: string, dto: UpdateNoteDto): Promise<NoteWithIdle> {
    const note = await this.findOne(userId, id);
    if (dto.title !== undefined) note.title = dto.title;
    if (dto.content !== undefined) note.content = dto.content;
    await note.save();
    return this.withIdle(note.toObject());
  }

  async reorder(userId: string, orderedIds: string[]): Promise<void> {
    const userObjectId = new Types.ObjectId(userId);
    const validIds = orderedIds.filter((id) => Types.ObjectId.isValid(id));
    // Resolve which IDs actually belong to the user (silently ignore foreign IDs).
    const owned = await this.noteModel
      .find({
        _id: { $in: validIds.map((id) => new Types.ObjectId(id)) },
        userId: userObjectId,
        archived: false,
      })
      .select('_id')
      .lean()
      .exec();
    const ownedSet = new Set(owned.map((d) => d._id.toString()));
    const ops = validIds
      .filter((id) => ownedSet.has(id))
      .map((id, idx) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id), userId: userObjectId },
          update: { $set: { order: idx } },
        },
      }));
    if (ops.length > 0) {
      await this.noteModel.bulkWrite(ops);
    }
  }

  async archive(userId: string, id: string): Promise<NoteWithIdle> {
    const note = await this.findOne(userId, id);
    note.archived = true;
    note.archivedAt = new Date();
    await note.save();
    return this.withIdle(note.toObject());
  }

  async snooze(userId: string, id: string): Promise<NoteWithIdle> {
    const note = await this.findOne(userId, id);
    note.idleSnoozeUntil = new Date(Date.now() + SNOOZE_DURATION_MS);
    await note.save();
    return this.withIdle(note.toObject());
  }

  async remove(userId: string, id: string): Promise<void> {
    const note = await this.findOne(userId, id);
    await note.deleteOne();
  }

  // ---------- promotion bookkeeping (used by NotesPromotionService) ----------

  async incrementPromotionAttempts(userId: string, id: string): Promise<void> {
    const note = await this.findOne(userId, id);
    note.promotionAttempts = (note.promotionAttempts ?? 0) + 1;
    await note.save();
  }

  async markPromoted(
    userId: string,
    id: string,
    promotedTo: {
      entityType: string;
      entityId: string;
      projectId?: string;
      customerId?: string;
    },
  ): Promise<NoteWithIdle> {
    const note = await this.findOne(userId, id);
    note.archived = true;
    note.archivedAt = new Date();
    note.promotedTo = {
      entityType: promotedTo.entityType as any,
      entityId: new Types.ObjectId(promotedTo.entityId),
      projectId: promotedTo.projectId ? new Types.ObjectId(promotedTo.projectId) : undefined,
      customerId: promotedTo.customerId ? new Types.ObjectId(promotedTo.customerId) : undefined,
    };
    await note.save();
    return this.withIdle(note.toObject());
  }

  // ---------- helpers ----------

  private withIdle(doc: any): NoteWithIdle {
    const now = Date.now();
    const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt);
    const snoozeUntil = doc.idleSnoozeUntil
      ? doc.idleSnoozeUntil instanceof Date
        ? doc.idleSnoozeUntil
        : new Date(doc.idleSnoozeUntil)
      : undefined;
    const isIdle =
      !doc.archived &&
      !doc.promotedTo &&
      now - updatedAt.getTime() > IDLE_THRESHOLD_MS &&
      (!snoozeUntil || snoozeUntil.getTime() < now);

    return {
      _id: doc._id.toString(),
      userId: doc.userId.toString(),
      title: doc.title,
      content: doc.content,
      order: doc.order,
      archived: doc.archived,
      archivedAt: doc.archivedAt,
      promotedTo: doc.promotedTo
        ? {
            entityType: doc.promotedTo.entityType,
            entityId: doc.promotedTo.entityId.toString(),
            projectId: doc.promotedTo.projectId?.toString(),
            customerId: doc.promotedTo.customerId?.toString(),
          }
        : undefined,
      idleSnoozeUntil: snoozeUntil,
      promotionAttempts: doc.promotionAttempts ?? 0,
      createdAt: doc.createdAt,
      updatedAt: updatedAt,
      isIdle,
    };
  }
}
