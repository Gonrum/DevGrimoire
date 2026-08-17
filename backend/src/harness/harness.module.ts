import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Harness, HarnessSchema } from './schemas/harness.schema';
import { HarnessService } from './harness.service';
import {
  CustomerProjectLink,
  CustomerProjectLinkSchema,
} from '../customers/schemas/customer-project-link.schema';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';

/**
 * Harness definitions (M-51 / H1). Controllers land in T-439.
 *
 * `CustomerProjectLink` and `Project` are registered as schemas rather than by
 * importing CustomersModule/ProjectsModule: resolution only reads the link's
 * `customerId` and checks that the project exists. Pulling in the full modules
 * would tie the harness to their service surface — and ProjectsModule would
 * bring the whole event/RAG chain along for a single existence check.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Harness.name, schema: HarnessSchema },
      { name: CustomerProjectLink.name, schema: CustomerProjectLinkSchema },
      { name: Project.name, schema: ProjectSchema },
    ]),
  ],
  providers: [HarnessService],
  exports: [HarnessService],
})
export class HarnessModule {}
