import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ValidationReportsController } from './validation-reports.controller';
import { ValidationReportsService } from './validation-reports.service';
import { ValidationReport, ValidationReportSchema } from './schemas/validation-report.schema';
import { TodosModule } from '../todos/todos.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ValidationReport.name, schema: ValidationReportSchema },
    ]),
    TodosModule,
  ],
  controllers: [ValidationReportsController],
  providers: [ValidationReportsService],
  exports: [ValidationReportsService],
})
export class ValidationReportsModule {}
