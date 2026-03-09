import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ProjectsModule } from './projects/projects.module';
import { TodosModule } from './todos/todos.module';
import { SessionsModule } from './sessions/sessions.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ChangelogModule } from './changelog/changelog.module';
import { MilestonesModule } from './milestones/milestones.module';
import { EventsModule } from './events/events.module';
import { ActivitiesModule } from './activities/activities.module';
import { PushModule } from './push/push.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { EnvironmentsModule } from './environments/environments.module';
import { SecretsModule } from './secrets/secrets.module';
import { ManualsModule } from './manuals/manuals.module';
import { ResearchModule } from './research/research.module';
import { SettingsModule } from './settings/settings.module';
import { NotificationsModule } from './notifications/notifications.module';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}

@Module({
  imports: [
    MongooseModule.forRoot(MONGODB_URI),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ProjectsModule,
    TodosModule,
    SessionsModule,
    KnowledgeModule,
    ChangelogModule,
    MilestonesModule,
    EventsModule,
    ActivitiesModule,
    PushModule,
    AuthModule,
    EnvironmentsModule,
    SecretsModule,
    ManualsModule,
    ResearchModule,
    SettingsModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
