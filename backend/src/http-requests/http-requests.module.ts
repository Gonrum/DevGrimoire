import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RequestCollection, RequestCollectionSchema } from './schemas/request-collection.schema';
import { SavedRequest, SavedRequestSchema } from './schemas/saved-request.schema';
import { RequestHistoryEntry, RequestHistorySchema } from './schemas/request-history.schema';
import { SecretsModule } from '../secrets/secrets.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { HttpRequestsService } from './http-requests.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RequestCollection.name, schema: RequestCollectionSchema },
      { name: SavedRequest.name, schema: SavedRequestSchema },
      { name: RequestHistoryEntry.name, schema: RequestHistorySchema },
    ]),
    SecretsModule,
    EnvironmentsModule,
  ],
  providers: [HttpRequestsService],
  exports: [HttpRequestsService],
  // controller wird in Task 7 ergänzt.
})
export class HttpRequestsModule {}
