import type { TransformFnParams } from 'class-transformer';

/**
 * Coerces a multipart `displayOrder` field to a number before validation.
 *
 * Every scalar in a `multipart/form-data` body arrives as a string, while the
 * global `ValidationPipe` uses `transform: true` but not
 * `enableImplicitConversion`. Without this transform `@IsInt()` would reject
 * every upload that sets a display order, even though the client sent a valid
 * integer.
 *
 * Unparseable input is deliberately returned unchanged instead of being coerced
 * to `NaN` or `0`. `Number('')` is `0`, which would silently turn a malformed
 * field into a valid first position; leaving it as a string lets `@IsInt()`
 * reject it with an error that names the field.
 */
export const toDisplayOrder = ({ value }: TransformFnParams): unknown => {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return value;
  }

  const parsed = Number(value);

  return Number.isNaN(parsed) ? value : parsed;
};
