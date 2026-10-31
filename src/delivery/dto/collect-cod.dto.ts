import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  NotEquals,
} from 'class-validator';
import { normalizeMoney } from '../../common/utils/normalize-money.js';

/**
 * Accepted monetary shape after `normalizeMoney`: at most ten integer digits
 * (the width of `Decimal(12,2)`) followed by exactly two fraction digits.
 */
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;

/** The canonical zero the amount must differ from, so the collection is positive. */
const ZERO_AMOUNT = '0.00';

/** ISO 4217 alphabetic code, matching the shape check on `orders.currency`. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Mirrors the bound used by the existing delivery-status notes field. */
const NOTES_MAX_LENGTH = 2000;

/**
 * Coerces a multipart text field to a canonical money string.
 *
 * A multipart body only carries strings, while a JSON body may carry a number.
 * `normalizeMoney` accepts both and always produces the exact two-decimal form
 * the database stores, so the amount is never rounded through a float.
 */
const toMoney = ({ value }: TransformFnParams): unknown =>
  normalizeMoney(value);

/** Trims and upper-cases a currency before the shape check runs. */
const toCurrencyCode = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Treats a blank optional note as absent rather than storing an empty string. */
const toOptionalNote = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Input contract for `POST /delivery/staff/assignments/:assignmentId/collect-cod`.
 *
 * ## The amount and currency are compared, not trusted
 *
 * Both are required so the courier confirms what they actually received, but the
 * service compares them against the order row and refuses any mismatch. They are
 * never used to derive the collection's value on their own.
 *
 * ## No receipt URL field
 *
 * `receiptProof` is deliberately absent. A receipt is an optional multipart file
 * under the `receiptProof` field; the service uploads it through Cloudinary and
 * persists only the metadata Cloudinary returns. A client-supplied URL is not
 * accepted anywhere, so it cannot point a collection at an arbitrary asset.
 *
 * `assignmentId` is likewise absent: ownership comes from the path and the
 * authenticated staff identity, and a body copy could only contradict them.
 */
export class CollectCodDto {
  @Transform(toMoney)
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'amount must be a positive amount with at most 2 decimal places and at most 10 integer digits',
  })
  @NotEquals(ZERO_AMOUNT, { message: 'amount must be greater than 0' })
  amount!: string;

  @Transform(toCurrencyCode)
  @IsString()
  @Matches(CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code',
  })
  currency!: string;

  @IsOptional()
  @Transform(toOptionalNote)
  @IsString()
  @MaxLength(NOTES_MAX_LENGTH)
  notes?: string;
}
