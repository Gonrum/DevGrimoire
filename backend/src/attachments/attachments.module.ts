import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Attachment, AttachmentSchema } from './schemas/attachment.schema';
import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { CustomersModule } from '../customers/customers.module';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';
import { Knowledge, KnowledgeSchema } from '../knowledge/schemas/knowledge.schema';
import { Release, ReleaseSchema } from '../releases/schemas/release.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Attachment.name, schema: AttachmentSchema },
      // Link-target lookups (entityType/entityId); idempotent to TodosModule/KnowledgeModule/ReleasesModule.
      { name: Todo.name, schema: TodoSchema },
      { name: Knowledge.name, schema: KnowledgeSchema },
      { name: Release.name, schema: ReleaseSchema },
    ]),
    CustomersModule,
  ],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
