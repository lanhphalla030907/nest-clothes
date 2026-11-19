import { Controller, Get, NotFoundException } from '@nestjs/common';
import { NextDropService } from './next-drops.service.js';

/**
 * Public read surface for the storefront.
 *
 * `GET /next-drops/active` returns the single published next drop, with its
 * linked collection and promotion, so the homepage can render the countdown
 * and coupon code. Returns 404 when nothing is published, which the client
 * treats as "hide the section". No authentication is required.
 */
@Controller('next-drops')
export class NextDropPublicController {
  constructor(private readonly nextDropService: NextDropService) {}

  @Get('active')
  async getActive() {
    const drop = await this.nextDropService.findPublished();
    if (drop === null) throw new NotFoundException('No published next drop');
    return drop;
  }
}
