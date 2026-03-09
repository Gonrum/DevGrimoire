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
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    return this.searchService.search(query.trim(), projectId, parsedLimit);
  }
}
