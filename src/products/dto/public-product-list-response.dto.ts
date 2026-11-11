import { ProductResponseDto } from './product-response.dto.js';

export interface CategoryFilterOptionDto {
  id: string;
  name: string;
  slug: string;
  count: number;
}

export interface PriceRangeFilterOptionDto {
  min: number;
  max: number;
}

export interface ProductFilterOptionsDto {
  categories: CategoryFilterOptionDto[];
  priceRange: PriceRangeFilterOptionDto;
  sizes: string[];
  colors: string[];
}

export class PublicProductListResponseDto {
  data: ProductResponseDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  filterOptions: ProductFilterOptionsDto;

  /**
   * Alias for backward compatibility if any client checks `products`.
   */
  get products(): ProductResponseDto[] {
    return this.data;
  }
}
