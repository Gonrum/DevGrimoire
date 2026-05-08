import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Project, ProjectSchema } from './schemas/project.schema';
import {
  CustomerProjectLink,
  CustomerProjectLinkSchema,
} from '../customers/schemas/customer-project-link.schema';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Project.name, schema: ProjectSchema },
      // CustomerProjectLink-Schema wird hier mitregistriert, weil ProjectsService
      // den `?customerId=`-Filter über die Link-Collection auflöst (T-199).
      // Die CustomersModule registriert dasselbe Schema zusätzlich für ihre
      // eigene Service-Logik — das ist OK, MongooseModule.forFeature ist idempotent.
      { name: CustomerProjectLink.name, schema: CustomerProjectLinkSchema },
    ]),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
