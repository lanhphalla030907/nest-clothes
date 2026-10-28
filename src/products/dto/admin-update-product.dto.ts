import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  PRODUCT_STATUS,
  type ProductStatus,
} from '../constants/product-status.constants.js';
import { UpdateProductDto } from './update-product.dto.js';

/**
 * Input contract for `PATCH /admin/products/:id`.
 *
 * Everything {@link UpdateProductDto} accepts, plus the two lifecycle columns, so an
 * administrator can edit content and move the lifecycle in one request without either
 * half having its own copy of the validation rules.
 *
 * The distinction that matters is between *omitted* and *present*:
 *
 * - `status` / `isActive` omitted -> neither column is written. A price correction or a
 *   typo fix therefore cannot change whether the product is sellable.
 * - `status` / `isActive` present -> exactly that column is written.
 *
 * `isActive` is a boolean and `status` a member of the lifecycle; neither is derived from
 * the other, because they are separate columns with separate meanings everywhere else in
 * the application.
 */
export class AdminUpdateProductDto extends UpdateProductDto {
  @IsOptional()
  @IsIn(Object.values(PRODUCT_STATUS), {
    message: `status must be one of: ${Object.values(PRODUCT_STATUS).join(', ')}`,
  })
  status?: ProductStatus;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}