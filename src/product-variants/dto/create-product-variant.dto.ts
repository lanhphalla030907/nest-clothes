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
 * Input contract for `POST /products/:productId/variants`.
 *
 * `id`, `productId`, `createdAt` and `updatedAt` are intentionally absent. The
 * global `ValidationPipe` runs with `forbidNonWhitelisted`, so a client
 * attempting to set any of them is rejected with 400 rather than having them
 * silently ignored — ownership and the timestamps are owned entirely by the
 * service and the database.
 *
 * `price` is typed as `string` because `normalizeMoney` canonicalises the
 * incoming number *or* string into a two-decimal string before validation runs.
 * The service persists that exact string, so the amount never passes through a
 * float on its way to the column.
 *
 * `isActive` is writable at creation so a variant can be staged inactive, and it
 * defaults to `true` in the service (and in the column) when omitted.
 */
export class CreateProductVariantDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeSku(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(SKU_MAX_LENGTH)
  @Matches(SKU_PATTERN, {
    message:
      'sku must be uppercase alphanumeric segments separated by a single ".", "_" or "-"',
  })
  sku: string;

  @Transform(({ value }) => normalizeMoney(value))
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'price must be a positive amount with at most 2 decimal places and at most 10 integer digits',
  })
  @NotEquals(ZERO_AMOUNT, { message: 'price must be greater than 0' })
  price: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
