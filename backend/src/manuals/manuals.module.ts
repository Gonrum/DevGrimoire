import { Module, OnModuleInit } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Manual, ManualDocument, ManualSchema } from './schemas/manual.schema';
import { ManualsService } from './manuals.service';
import { ManualsController } from './manuals.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Manual.name, schema: ManualSchema },
    ]),
  ],
  controllers: [ManualsController],
  providers: [ManualsService],
  exports: [ManualsService],
})
export class ManualsModule implements OnModuleInit {
  constructor(
    @InjectModel(Manual.name) private manualModel: Model<ManualDocument>,
  ) {}

  async onModuleInit() {
    // Migration: drop old unique index on projectId (single-document era)
    try {
      await this.manualModel.collection.dropIndex('projectId_1');
    } catch {
      // Index doesn't exist — already migrated
    }
    // Ensure new indexes are created
    await this.manualModel.syncIndexes();
  }
}
