import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Counter, CounterDocument, CounterSchema } from './schemas/counter.schema';
import { Todo, TodoDocument, TodoSchema } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneSchema } from '../milestones/schemas/milestone.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { CountersService } from './counters.service';
import { NumberMigrationService } from './number-migration.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Counter.name, schema: CounterSchema },
      { name: Todo.name, schema: TodoSchema },
      { name: Milestone.name, schema: MilestoneSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
  ],
  providers: [CountersService, NumberMigrationService],
  exports: [CountersService, MongooseModule],
})
export class CountersModule implements OnModuleInit {
  private readonly logger = new Logger(CountersModule.name);

  constructor(
    @InjectModel(Counter.name) private readonly counterModel: Model<CounterDocument>,
    @InjectModel(Todo.name) private readonly todoModel: Model<TodoDocument>,
  ) {}

  /**
   * Migration: Unique-Indizes aus der Zeit vor Kunden-Todos. Ohne `customerId`
   * im Schlüssel teilen sich alle Kunden `projectId: null` — der zweite Kunde
   * mit eigenem Todo-Zähler lief in E11000 (counters), und Kunden-Todo-Nummern
   * hätten über alle Kunden hinweg eindeutig sein müssen (todos). Die
   * Nachfolger mit `customerId` legt Mongoose per autoIndex an.
   */
  async onModuleInit(): Promise<void> {
    await this.dropLegacyIndex(this.counterModel, 'projectId_1_entity_1');
    await this.dropLegacyIndex(this.todoModel, 'projectId_1_number_1');
  }

  private async dropLegacyIndex(model: Model<CounterDocument> | Model<TodoDocument>, name: string): Promise<void> {
    try {
      await model.collection.dropIndex(name);
      this.logger.log(`Veralteten Index ${model.collection.collectionName}.${name} entfernt`);
    } catch {
      // Bereits migriert oder nie angelegt
    }
  }
}
