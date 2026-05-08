import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomerTransferController } from './customer-transfer.controller';
import { CustomerTransferService } from './customer-transfer.service';
import { CustomersModule } from '../customers/customers.module';
import { ContactsModule } from '../contacts/contacts.module';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { Contact, ContactSchema } from '../contacts/schemas/contact.schema';
import { Knowledge, KnowledgeSchema } from '../knowledge/schemas/knowledge.schema';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';
import { Environment, EnvironmentSchema } from '../environments/schemas/environment.schema';
import { Secret, SecretSchema } from '../secrets/schemas/secret.schema';
import { Research, ResearchSchema } from '../research/schemas/research.schema';
import {
  RecurringTask,
  RecurringTaskSchema,
} from '../recurring-tasks/schemas/recurring-task.schema';

@Module({
  imports: [
    CustomersModule,
    ContactsModule,
    MongooseModule.forFeature([
      // All schemas registered here are idempotent with their owning modules —
      // we go direct to model.find/insertMany for the bulk export/import path
      // because service-layer hooks (events, validation, counters) would fight
      // with bulk operations.
      { name: Customer.name, schema: CustomerSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Knowledge.name, schema: KnowledgeSchema },
      { name: Todo.name, schema: TodoSchema },
      { name: Environment.name, schema: EnvironmentSchema },
      { name: Secret.name, schema: SecretSchema },
      { name: Research.name, schema: ResearchSchema },
      { name: RecurringTask.name, schema: RecurringTaskSchema },
    ]),
  ],
  controllers: [CustomerTransferController],
  providers: [CustomerTransferService],
})
export class CustomerTransferModule {}
