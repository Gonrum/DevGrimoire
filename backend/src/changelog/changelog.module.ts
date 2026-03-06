import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Changelog, ChangelogSchema } from './schemas/changelog.schema';
import { ChangelogService } from './changelog.service';
import { ChangelogController } from './changelog.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Changelog.name, schema: ChangelogSchema },
    ]),
  ],
  controllers: [ChangelogController],
  providers: [ChangelogService],
  exports: [ChangelogService],
})
export class ChangelogModule {}
