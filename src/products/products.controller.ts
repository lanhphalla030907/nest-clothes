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
  Query,
} from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductResponseDto } from './dto/product-response.dto.js';
import { PublicProductQueryDto } from './dto/public-product-query.dto.js';
import {
  PublicProductListResponseDto,
  type ProductFilterOptionsDto,
} from './dto/public-product-list-response.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductsService } from './products.service.js';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    return this.productsService.create(dto);
  }

  @Get('new-arrivals')
  findNewArrivals(@Query('limit') limit?: string): Promise<ProductResponseDto[]> {
    const n = limit ? parseInt(limit, 10) : 8;
    return this.productsService.findNewArrivals(Number.isNaN(n) || n <= 0 ? 8 : Math.min(n, 50));
  }

  @Get('best-sellers')
  findBestSellers(@Query('limit') limit?: string): Promise<ProductResponseDto[]> {
    const n = limit ? parseInt(limit, 10) : 8;
    return this.productsService.findBestSellers(Number.isNaN(n) || n <= 0 ? 8 : Math.min(n, 50));
  }

  @Get('filters')
  getFilterOptions(): Promise<ProductFilterOptionsDto> {
    return this.productsService.getFilterOptions();
  }

  @Get()
  findAll(
    @Query() query: PublicProductQueryDto,
  ): Promise<PublicProductListResponseDto> {
    return this.productsService.findPublicProducts(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ProductResponseDto> {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponseDto> {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.productsService.remove(id);
  }
}
