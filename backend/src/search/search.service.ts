import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Todo, TodoDocument } from '../todos/schemas/todo.schema';
import { Knowledge, KnowledgeDocument } from '../knowledge/schemas/knowledge.schema';
import { Changelog, ChangelogDocument } from '../changelog/schemas/changelog.schema';
import { Research, ResearchDocument } from '../research/schemas/research.schema';
import { Milestone, MilestoneDocument } from '../milestones/schemas/milestone.schema';

export interface SearchResult {
  type: 'todo' | 'knowledge' | 'changelog' | 'research' | 'milestone';
  id: string;
  projectId: string;
  title: string;
  snippet: string;
  status?: string;
  priority?: string;
}

function makeSnippet(text: string | undefined, maxLen = 150): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(Todo.name) private todoModel: Model<TodoDocument>,
    @InjectModel(Knowledge.name) private knowledgeModel: Model<KnowledgeDocument>,
    @InjectModel(Changelog.name) private changelogModel: Model<ChangelogDocument>,
    @InjectModel(Research.name) private researchModel: Model<ResearchDocument>,
    @InjectModel(Milestone.name) private milestoneModel: Model<MilestoneDocument>,
  ) {}

  async search(query: string, projectId?: string, limit = 20): Promise<SearchResult[]> {
    const regex = new RegExp(escapeRegex(query), 'i');
    const projectFilter = projectId ? { projectId } : {};

    const [todos, knowledge, changelogs, research, milestones] = await Promise.all([
      this.todoModel
        .find({
          ...projectFilter,
          archived: { $ne: true },
          $or: [{ title: regex }, { description: regex }],
        })
        .limit(limit)
        .exec(),
      this.knowledgeModel
        .find({
          ...projectFilter,
          $or: [{ topic: regex }, { content: regex }],
        })
        .limit(limit)
        .exec(),
      this.changelogModel
        .find({
          ...projectFilter,
          $or: [{ version: regex }, { summary: regex }, { changes: regex }],
        })
        .limit(limit)
        .exec(),
      this.researchModel
        .find({
          ...projectFilter,
          $or: [{ title: regex }, { content: regex }],
        })
        .limit(limit)
        .exec(),
      this.milestoneModel
        .find({
          ...projectFilter,
          archived: { $ne: true },
          $or: [{ name: regex }, { description: regex }],
        })
        .limit(limit)
        .exec(),
    ]);

    const results: SearchResult[] = [];

    for (const t of todos) {
      results.push({
        type: 'todo',
        id: t._id.toString(),
        projectId: t.projectId.toString(),
        title: t.title,
        snippet: makeSnippet(t.description),
        status: t.status,
        priority: t.priority,
      });
    }

    for (const k of knowledge) {
      results.push({
        type: 'knowledge',
        id: k._id.toString(),
        projectId: k.projectId.toString(),
        title: k.topic,
        snippet: makeSnippet(k.content),
      });
    }

    for (const c of changelogs) {
      results.push({
        type: 'changelog',
        id: c._id.toString(),
        projectId: c.projectId.toString(),
        title: c.version ? `v${c.version}` : 'Changelog',
        snippet: makeSnippet(c.summary || c.changes?.join(', ')),
      });
    }

    for (const r of research) {
      results.push({
        type: 'research',
        id: r._id.toString(),
        projectId: r.projectId.toString(),
        title: r.title,
        snippet: makeSnippet(r.content),
      });
    }

    for (const m of milestones) {
      results.push({
        type: 'milestone',
        id: m._id.toString(),
        projectId: m.projectId.toString(),
        title: m.name,
        snippet: makeSnippet(m.description),
        status: m.status,
      });
    }

    return results;
  }
}
