import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomerTemplate, CustomerTemplateSchema } from './schemas/customer-template.schema';
import { CustomerTemplatesService } from './customer-templates.service';
import { CustomerTemplatesController } from './customer-templates.controller';
import { TodosModule } from '../todos/todos.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { ContactsModule } from '../contacts/contacts.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CustomerTemplate.name, schema: CustomerTemplateSchema },
    ]),
    TodosModule,
    EnvironmentsModule,
    ContactsModule,
    MonitoringModule,
    WorkflowsModule,
    CustomersModule,
  ],
  controllers: [CustomerTemplatesController],
  providers: [CustomerTemplatesService],
  exports: [CustomerTemplatesService],
})
export class CustomerTemplatesModule {}
