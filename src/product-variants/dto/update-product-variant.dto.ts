import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  NotEquals,
} from 'class-validator';
import { normalizeMoney } from '../../common/utils/normalize-money.js';
import { normalizeSku } from '../../common/utils/normalize-sku.js';

/**
 * Accepted SKU shape after `normalizeSku`: uppercase alphanumeric segments
 * separated by a single `.`, `_` or `-`.
 *
 * The check runs *after* normalisation, so a client may send `  tshirt-blk-m `
 * and it is stored as `TSHIRT-BLK-M`. Whitespace and control characters are
 * rejected outright rather than folded away, because a SKU that needs trimming
 * in the middle is a data-entry mistake, not a formatting choice.
 */
const SKU_PATTERN = /^[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;

/**
 * Accepted monetary shape after `normalizeMoney`: at most ten integer digits
 * (the width of `Decimal(12,2)`) followed by exactly two fraction digits.
 */
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;

/** The canonical zero the amount must differ from, so the price is positive. */
const ZERO_AMOUNT = '0.00';

/** Mirrors the `product_variants.sku` column width so validation bounds the database. */
const SKU_MAX_LENGTH = 100;

/**
 * Input contract for `PATCH /products/:productId/variants/:variantId`.
 *
 * Only editable variant attributes are accepted. `id`, `productId`, `createdAt`
 * and `updatedAt` are absent, and because the global pipe runs
 * `forbidNonWhitelisted` a client that sends them gets a 400 instead of a
 * silently ignored field. Moving a variant to another product is not an edit; it
 * is a separate, authorised action that does not exist yet.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a create,
 * and only the requiredness is relaxed.
 */
export class UpdateProductVariantDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeSku(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(SKU_MAX_LENGTH)
  @Matches(SKU_PATTERN, {
    message:
      'sku must be uppercase alphanumeric segments separated by a single ".", "_" or "-"',
  })
  sku?: string;

  @Transform(({ value }) => normalizeMoney(value))
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'price must be a positive amount with at most 2 decimal places and at most 10 integer digits',
  })
  @NotEquals(ZERO_AMOUNT, { message: 'price must be greater than 0' })
  price?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
