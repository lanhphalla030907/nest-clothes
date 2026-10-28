import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  PRODUCT_STATUS,
  type ProductStatus,
} from '../constants/product-status.constants.js';
import { CreateProductDto } from './create-product.dto.js';

/**
 * Input contract for `POST /admin/products`.
 *
 * Everything {@link CreateProductDto} accepts, plus the two lifecycle columns. Inheriting
 * is the point here rather than an accident of style: the catalogue content rules —
 * normalisation, slug shape, price bounds — must be *the same rules*, not a second copy
 * that can drift. Only the requiredness of the added fields differs, and optionality is
 * declared per field exactly as the parent DTOs do.
 *
 * `id`, `createdAt` and `updatedAt` stay absent, and the global pipe runs
 * `forbidNonWhitelisted`, so a request naming them is refused with 400.
 */
export class AdminCreateProductDto extends CreateProductDto {
  /**
   * One of the three lifecycle values, and nothing else.
   *
   * `@IsIn` rather than a hand-written check because the list is the same list the
   * column's documentation and the response DTO already use; a fourth value could only
   * arrive from a client that has learned a string this application does not accept.
   */
  @IsOptional()
  @IsIn(Object.values(PRODUCT_STATUS), {
    message: `status must be one of: ${Object.values(PRODUCT_STATUS).join(', ')}`,
  })
  status?: ProductStatus;

  /**
   * The record-level enable flag, independent of `status`.
   *
   * Sending neither field leaves both defaults in place, so an admin that only names
   * catalogue content gets the same product a public create would produce.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}