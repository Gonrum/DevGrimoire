import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProjectsModule } from './projects/projects.module';
import { TodosModule } from './todos/todos.module';
import { SessionsModule } from './sessions/sessions.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ChangelogModule } from './changelog/changelog.module';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}

@Module({
  imports: [
    MongooseModule.forRoot(MONGODB_URI),
    ProjectsModule,
    TodosModule,
    SessionsModule,
    KnowledgeModule,
    ChangelogModule,
  ],
})
export class AppModule {}
