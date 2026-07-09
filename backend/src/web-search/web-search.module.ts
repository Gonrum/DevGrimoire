import { Module } from '@nestjs/common';
import { HttpModule, HttpService } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { WebSearchService, SETTING_SEARXNG_URL } from './services/web-search.service';
import { ReadabilityService } from './services/readability.service';
import { WebSearchRateLimiterService } from './services/web-search-rate-limiter.service';
import { SearxngProvider } from './providers/searxng.provider';
import { WebSearchController } from './web-search.controller';
import { SettingsModule } from '../settings/settings.module';
import { SettingsService } from '../settings/settings.service';
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
  providers: [
    WebSearchService,
    ReadabilityService,
    WebSearchRateLimiterService,
    {
      provide: SearxngProvider,
      useFactory: (http: HttpService, settings: SettingsService) => {
        const envUrl = process.env.SEARXNG_URL || 'http://searxng:8080';
        const getUrl = async () => {
          const value = await settings.getOrDefault(SETTING_SEARXNG_URL, envUrl);
          return value.replace(/\/$/, '');
        };
        return new SearxngProvider(http, getUrl);
      },
      inject: [HttpService, SettingsService],
    },
  ],
  exports: [WebSearchService, ReadabilityService, WebSearchRateLimiterService],
})
export class WebSearchModule {}
