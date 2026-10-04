import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaywayCallbackDto } from './create-payment.dto.js';

/**
 * Validates a PayWay webhook body **without** the global `ValidationPipe`'s rules.
 *
 * ## Why this exists
 *
 * Every other request body in this application goes through the global pipe configured
 * with `whitelist: true, forbidNonWhitelisted: true`. That is the correct default: a
 * client that sends `{"addressId": "…", "totalAmount": "0.01"}` gets a 400 instead of a
 * silently ignored price.
 *
 * It is exactly wrong for a provider webhook. `forbidNonWhitelisted` means any key this
 * class does not declare becomes a 400 — so the day PayWay adds one field to its
 * callback, **every customer payment stops being recorded**, orders stay `PENDING`
 * forever, and the failure looks like ours rather than theirs. An integration whose
 * availability depends on a third party's field list cannot be built that way.
 *
 * ## What it validates instead
 *
 * Only the declared fields, only their types, and nothing else:
 *
 * - `whitelist: false`, so unrecognised keys are left alone rather than rejected.
 * - `forbidNonWhitelisted: false`, for the same reason.
 * - `transform: true`, so the declared fields are still coerced and range-checked by
 *   their decorators — a `merchant_ref` that is an object instead of a string is a 400,
 *   because a lookup key of the wrong type is a malformed request rather than a
 *   provider's new field.
 *
 * A body that is not a plain object is a 400 as well. `JSON.parse('"x"')` and
 * `JSON.parse('[]')` both succeed, and treating either as a DTO instance would have the
 * service reading `undefined` off a string.
 *
 * ## None of this makes the payload trustworthy
 *
 * It only decides the request is *well-formed*. Whether the payment is real is settled
 * by `PaymentsService` asking PayWay directly — see the note on
 * {@link PaywayCallbackDto}.
 *
 * @throws BadRequestException 400 when the body is not an object, or a declared field
 *   has the wrong type or length.
 */
export async function parsePaywayCallback(
  body: unknown,
): Promise<PaywayCallbackDto> {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  ) {
    throw new BadRequestException(
      'The callback body must be a JSON object',
    );
  }

  const dto = plainToInstance(PaywayCallbackDto, body, {
    // Only the declared properties are copied across. Without this, every unknown key
    // PayWay sends would be set on the instance and simply ignored — which works, but
    // leaves the object carrying provider data that a future `Object.assign` or a
    // `console.log` would happily print.
    excludeExtraneousValues: true,
  });

  const errors = await validate(dto as object, {
    whitelist: false,
    forbidNonWhitelisted: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    // Only the *field* names are reported, never their submitted values: this endpoint
    // is unauthenticated, and echoing an attacker's payload back to them gains nothing.
    //
    // `error.property` rather than the keys of `error.constraints` — the latter are the
    // names of the rules that failed (`isString`, `maxLength`), which would tell a
    // sender nothing about which field to fix and would read as though several fields
    // were at fault.
    const fields = [
      ...new Set(
        errors.map((error) => error.property).filter((property) => property !== ''),
      ),
    ];

    throw new BadRequestException(
      `The callback body is malformed (${fields.join(', ')})`,
    );
  }

  return dto;
}
