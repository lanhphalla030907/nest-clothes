import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { PosterResponseDto } from '../../posters/dto/poster-response.dto.js';
import { UpdatePosterDto } from '../../posters/dto/update-poster.dto.js';
import { UploadPosterImageDto } from '../../posters/dto/upload-poster-image.dto.js';
import { PosterImageUploadInterceptor } from '../../posters/interceptors/poster-image-upload.interceptor.js';
import type { UploadedPosterImageFile } from '../../posters/interfaces/uploaded-poster-image-file.js';
import { PostersService } from '../../posters/posters.service.js';

/**
 * Administrative poster management.
 *
 * Every method delegates to {@link PostersService}. The guard order is
 * deliberate: `JwtAuthGuard` establishes the caller, then `RolesGuard` checks
 * whether that identity is an administrator.
 */
@Controller('admin/posters')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminPostersController {
  constructor(private readonly postersService: PostersService) {}

  @Get()
  findAll(): Promise<PosterResponseDto[]> {
    return this.postersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PosterResponseDto> {
    return this.postersService.findOne(id);
  }

  @Post()
  @UseInterceptors(PosterImageUploadInterceptor)
  create(
    @UploadedFile() file: UploadedPosterImageFile | undefined,
    @Body() dto: UploadPosterImageDto,
  ): Promise<PosterResponseDto> {
    return this.postersService.createWithImage(dto, file);
  }

  @Post(':id/images/upload')
  @UseInterceptors(PosterImageUploadInterceptor)
  uploadImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedPosterImageFile | undefined,
    @Body() dto: UploadPosterImageDto,
  ): Promise<PosterResponseDto> {
    return this.postersService.uploadImage(id, file, dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePosterDto,
  ): Promise<PosterResponseDto> {
    return this.postersService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.postersService.remove(id);
  }
}
