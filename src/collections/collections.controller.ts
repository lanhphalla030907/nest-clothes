import { Controller, Get, Param, Query } from '@nestjs/common';
import { CollectionDetailQueryDto, CollectionQueryDto } from './dto/collection-query.dto.js';
import { CollectionResponseDto } from './dto/collection-response.dto.js';
import { CollectionsService } from './collections.service.js';

@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  findActive(@Query() query: CollectionQueryDto): Promise<CollectionResponseDto[]> {
    return this.collectionsService.findActive(query.limit);
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string, @Query() query: CollectionDetailQueryDto) {
    return this.collectionsService.findPublicDetail(slug, query.page ?? 1, query.limit ?? 12);
  }
}
