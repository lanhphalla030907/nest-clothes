import type { Address } from '../repositories/address.repository.js';

/**
 * Outbound representation of one address.
 *
 * Built field by field from the stored row, so nothing can leak by accident: the
 * `user` relation is never selected by the repository, so no user column — least of
 * all `passwordHash` — is even in memory to be serialised.
 *
 * Ownership is expressed by `userId` alone. There is no nested `user` object and no
 * `email`: an address book is the caller's own data, and a client that needed the
 * owner's email already has it from their own account.
 *
 * ## What this response deliberately does not contain
 *
 * No `user`, no `createdBy`, no delivery or verification state. Those belong to a
 * future phase if they are ever needed; carrying empty placeholders now would
 * promise a contract this feature has not designed.
 *
 * The field set is the address *as the customer entered it*, which is what a
 * checkout form needs to show "Deliver to Home — 12 Mill Lane, Bristol". When an
 * order is placed it will copy these exact fields into an immutable snapshot
 * rather than reference this row, so that editing an address here can never change
 * where a past order went.
 */
export class AddressResponseDto {
  id: string;
  userId: string;
  /** Customer-facing name for the entry, such as `Home` or `Work`. */
  label: string;
  /** Who the parcel is for. */
  recipientName: string;
  /**
   * A string, deliberately: a leading `+`, a leading zero and internal spaces are
   * all significant in international formats, none of which survive a number.
   */
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvince: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2, normalised to uppercase. */
  countryCode: string;
  /**
   * Whether this is the address a checkout should pre-select. At most one address
   * per user is ever `true`.
   */
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(address: Address): AddressResponseDto {
    const dto = new AddressResponseDto();

    dto.id = address.id;
    dto.userId = address.userId;
    dto.label = address.label;
    dto.recipientName = address.recipientName;
    dto.phone = address.phone;
    dto.addressLine1 = address.addressLine1;
    dto.addressLine2 = address.addressLine2;
    dto.city = address.city;
    dto.stateProvince = address.stateProvince;
    dto.postalCode = address.postalCode;
    dto.countryCode = address.countryCode;
    dto.isDefault = address.isDefault;
    dto.createdAt = address.createdAt;
    dto.updatedAt = address.updatedAt;
    return dto;
  }
}
