import { Controller, Get } from '@nestjs/common';
import { PosterResponseDto } from './dto/poster-response.dto.js';
import { PostersService } from './posters.service.js';

/**
 * Public storefront routing only: return the active posters in display order.
 */
@Controller('posters')
export class PostersController {
  constructor(private readonly postersService: PostersService) {}

  @Get()
  findActive(): Promise<PosterResponseDto[]> {
    return this.postersService.findActive();
  }
}
