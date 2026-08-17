import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Stack, StackDocument, StackEntry } from './schemas/stack.schema';
import { CreateStackDto } from './dto/create-stack.dto';
import { UpdateStackDto } from './dto/update-stack.dto';
import { CreateStackEntryDto } from './dto/create-stack-entry.dto';
import { UpdateStackEntryDto } from './dto/update-stack-entry.dto';
import { stackToMarkdown, entryToMarkdown, slugifyFilename } from './stack-markdown';


@Injectable()
export class StacksService {
  constructor(
    @InjectModel(Stack.name) private readonly stackModel: Model<StackDocument>,
  ) {}

  private entriesOf(stack: StackDocument): Types.DocumentArray<StackEntry> {
    return stack.entries;
  }

  private sorted(stack: StackDocument) {
    this.entriesOf(stack).sort((a, b) => a.order - b.order);
    return stack;
  }

  async create(dto: CreateStackDto): Promise<StackDocument> {
    return this.stackModel.create({
      name: dto.name,
      description: dto.description,
      entries: [],
    });
  }

  async findAll() {
    const stacks = await this.stackModel.find().sort({ updatedAt: -1 }).lean().exec();
    return stacks.map((s) => ({
      _id: s._id,
      name: s.name,
      description: s.description,
      entryCount: s.entries?.length ?? 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  async findById(id: string): Promise<StackDocument> {
    const stack = await this.stackModel.findById(id).exec();
    if (!stack) throw new NotFoundException('Stack not found');
    return this.sorted(stack);
  }

  async update(id: string, dto: UpdateStackDto): Promise<StackDocument> {
    const stack = await this.stackModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!stack) throw new NotFoundException('Stack not found');
    return this.sorted(stack);
  }

  async remove(id: string): Promise<void> {
    const res = await this.stackModel.findByIdAndDelete(id).exec();
    if (!res) throw new NotFoundException('Stack not found');
  }

  async addEntry(id: string, dto: CreateStackEntryDto): Promise<StackDocument> {
    const stack = await this.stackModel.findById(id).exec();
    if (!stack) throw new NotFoundException('Stack not found');
    const entries = this.entriesOf(stack);
    const maxOrder = entries.reduce((m, e) => Math.max(m, e.order), -1);
    entries.push({ title: dto.title, content: dto.content ?? '', order: maxOrder + 1 });
    await stack.save();
    return this.sorted(stack);
  }

  async updateEntry(id: string, entryId: string, dto: UpdateStackEntryDto): Promise<StackDocument> {
    const stack = await this.stackModel.findById(id).exec();
    if (!stack) throw new NotFoundException('Stack not found');
    const entry = this.entriesOf(stack).id(entryId);
    if (!entry) throw new NotFoundException('Entry not found');
    if (dto.title !== undefined) entry.title = dto.title;
    if (dto.content !== undefined) entry.content = dto.content;
    if (dto.order !== undefined) entry.order = dto.order;
    await stack.save();
    return this.sorted(stack);
  }

  async removeEntry(id: string, entryId: string): Promise<StackDocument> {
    const stack = await this.stackModel.findById(id).exec();
    if (!stack) throw new NotFoundException('Stack not found');
    const entries = this.entriesOf(stack);
    const before = entries.length;
    entries.pull(entryId);
    if (entries.length === before) throw new NotFoundException('Entry not found');
    await stack.save();
    return this.sorted(stack);
  }

  async reorderEntries(id: string, entryIds: string[]): Promise<StackDocument> {
    const stack = await this.stackModel.findById(id).exec();
    if (!stack) throw new NotFoundException('Stack not found');
    const entries = this.entriesOf(stack);
    entryIds.forEach((eid, index) => {
      const entry = entries.id(eid);
      if (entry) entry.order = index;
    });
    await stack.save();
    return this.sorted(stack);
  }

  async exportAsMarkdown(id: string, entryId?: string): Promise<{ content: string; filename: string }> {
    const stack = await this.findById(id);
    if (entryId) {
      const entry = this.entriesOf(stack).id(entryId);
      if (!entry) throw new NotFoundException('Entry not found');
      return {
        content: entryToMarkdown(entry),
        filename: `${slugifyFilename(entry.title, 'bereich')}.md`,
      };
    }
    return {
      content: stackToMarkdown(stack),
      filename: `${slugifyFilename(stack.name, 'stack')}.md`,
    };
  }
}
