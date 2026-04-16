import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { WebSearchService } from './services/web-search.service';
import { ReadabilityService } from './services/readability.service';
import { WebSearchController } from './web-search.controller';
import { SettingsModule } from '../settings/settings.module';
import { WebSearchCache, WebSearchCacheSchema } from './schemas/web-search-cache.schema';
import { WebFetchCache, WebFetchCacheSchema } from './schemas/web-fetch-cache.schema';

@Module({
  imports: [
    HttpModule.register({
      timeout: 15000,
      maxRedirects: 0,
    }),
    MongooseModule.forFeature([
      { name: WebSearchCache.name, schema: WebSearchCacheSchema },
      { name: WebFetchCache.name, schema: WebFetchCacheSchema },
    ]),
    SettingsModule,
  ],
  controllers: [WebSearchController],
  providers: [WebSearchService, ReadabilityService],
  exports: [WebSearchService, ReadabilityService],
})
export class WebSearchModule {}
