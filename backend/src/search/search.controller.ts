import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(
    @Query('q') query: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!query || !query.trim()) return [];
    const parsedLimit = Math.min(limit ? parseInt(limit, 10) : 20, 100);
    return this.searchService.search(query.trim(), projectId, parsedLimit);
  }
}
