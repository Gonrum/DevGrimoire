import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { ProjectTransferService } from './project-transfer.service';
import { ProjectTransferController } from './project-transfer.controller';
import { TodosModule } from '../todos/todos.module';
import { SessionsModule } from '../sessions/sessions.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ChangelogModule } from '../changelog/changelog.module';
import { MilestonesModule } from '../milestones/milestones.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ManualsModule } from '../manuals/manuals.module';
import { ResearchModule } from '../research/research.module';
import { SchemasModule } from '../schemas/schemas.module';
import { DependenciesModule } from '../dependencies/dependencies.module';
import { FeaturesModule } from '../features/features.module';
import { CountersModule } from '../counters/counters.module';
import { Secret, SecretSchema } from '../secrets/schemas/secret.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Secret.name, schema: SecretSchema },
    ]),
    MulterModule.register({ limits: { fileSize: 50 * 1024 * 1024 } }),
    TodosModule,
    SessionsModule,
    KnowledgeModule,
    ChangelogModule,
    MilestonesModule,
    EnvironmentsModule,
    SecretsModule,
    ManualsModule,
    ResearchModule,
    SchemasModule,
    DependenciesModule,
    FeaturesModule,
    CountersModule,
  ],
  controllers: [ProjectTransferController],
  providers: [ProjectTransferService],
  exports: [ProjectTransferService],
})
export class ProjectTransferModule {}
