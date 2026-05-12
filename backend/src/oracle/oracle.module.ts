import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OracleController } from './oracle.controller';
import { OracleService } from './oracle.service';
import { OracleSuggestion, OracleSuggestionSchema } from './schemas/oracle-suggestion.schema';
import { Todo, TodoSchema } from '../todos/schemas/todo.schema';
import { Milestone, MilestoneSchema } from '../milestones/schemas/milestone.schema';
import {
  ValidationReport,
  ValidationReportSchema,
} from '../validation-reports/schemas/validation-report.schema';
import { TodosModule } from '../todos/todos.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OracleSuggestion.name, schema: OracleSuggestionSchema },
      { name: Todo.name, schema: TodoSchema },
      { name: Milestone.name, schema: MilestoneSchema },
      { name: ValidationReport.name, schema: ValidationReportSchema },
    ]),
    TodosModule,
  ],
  controllers: [OracleController],
  providers: [OracleService],
  exports: [OracleService],
})
export class OracleModule {}
