import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Note, NoteSchema } from './schemas/note.schema';
import { NotesService } from './notes.service';
import { NotesPromotionService } from './notes-promotion.service';
import { NotesController } from './notes.controller';
import { ChatModule } from '../chat/chat.module';
import { ProjectsModule } from '../projects/projects.module';
import { CustomersModule } from '../customers/customers.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SnippetsModule } from '../snippets/snippets.module';
import { TodosModule } from '../todos/todos.module';
import { ResearchModule } from '../research/research.module';
import { ManualsModule } from '../manuals/manuals.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Note.name, schema: NoteSchema }]),
    ChatModule,
    ProjectsModule,
    CustomersModule,
    KnowledgeModule,
    SnippetsModule,
    TodosModule,
    ResearchModule,
    ManualsModule,
  ],
  controllers: [NotesController],
  providers: [NotesService, NotesPromotionService],
  exports: [NotesService],
})
export class NotesModule {}
