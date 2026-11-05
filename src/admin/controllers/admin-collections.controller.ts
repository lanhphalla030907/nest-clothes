import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CollectionsService } from '../../collections/collections.service.js';
import { CreateCollectionDto } from '../../collections/dto/create-collection.dto.js';
import { UpdateCollectionDto } from '../../collections/dto/update-collection.dto.js';
import { UpdateCollectionStatusDto } from '../../collections/dto/update-collection-status.dto.js';
import { CollectionImageUploadInterceptor } from '../../collections/interceptors/collection-image-upload.interceptor.js';
import type { UploadedCollectionImageFile } from '../../collections/interfaces/uploaded-collection-image-file.js';
import { Role } from '../../generated/prisma/enums.js';

@Controller('admin/collections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  findAll() { return this.collectionsService.findAll(); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.collectionsService.findOne(id); }

  @Post()
  @UseInterceptors(CollectionImageUploadInterceptor)
  create(@UploadedFile() file: UploadedCollectionImageFile | undefined, @Body() dto: CreateCollectionDto) {
    return this.collectionsService.createWithImage(dto, file);
  }

  @Post(':id/images/upload')
  @UseInterceptors(CollectionImageUploadInterceptor)
  replaceImage(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedCollectionImageFile | undefined) {
    return this.collectionsService.replaceImage(id, file);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCollectionDto) {
    return this.collectionsService.update(id, dto);
  }

  @Patch(':id/status')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCollectionStatusDto) {
    return this.collectionsService.updateStatus(id, dto.isActive);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> { return this.collectionsService.remove(id); }
}
