import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { Customer, CustomerSchema } from './schemas/customer.schema';
import {
  CustomerProjectLink,
  CustomerProjectLinkSchema,
} from './schemas/customer-project-link.schema';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Customer.name, schema: CustomerSchema },
      { name: CustomerProjectLink.name, schema: CustomerProjectLinkSchema },
      // Todo-Schema wird hier mitregistriert, weil der Customer-Dashboard-Endpoint
      // Open-Todo-Counts pro Kunde aggregiert (T-212). Idempotent zu TodosModule.
      { name: Todo.name, schema: TodoSchema },
    ]),
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
