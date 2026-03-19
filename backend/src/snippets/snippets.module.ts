import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Snippet, SnippetSchema } from './schemas/snippet.schema';
import { SnippetsService } from './snippets.service';
import { SnippetsController } from './snippets.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Snippet.name, schema: SnippetSchema },
    ]),
  ],
  controllers: [SnippetsController],
  providers: [SnippetsService],
  exports: [SnippetsService],
})
export class SnippetsModule {}
