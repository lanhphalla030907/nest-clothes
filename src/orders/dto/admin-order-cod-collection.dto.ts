import { toMoneyString } from '../../common/utils/money.js';

/** Whether a `cod_collections` row exists for the order. */
export type CodCollectionStatus = 'COLLECTED' | 'NOT_COLLECTED';

/** The safe collector identity a COD collection may expose. */
export interface AdminOrderCodCollectionCollectorSource {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** The collection columns the administrative responses are allowed to read. */
export interface AdminOrderCodCollectionSource {
  id: string;
  amount: unknown;
  currency: string;
  collectedAt: Date;
  collectedBy: AdminOrderCodCollectionCollectorSource;
}

/** The staff member who recorded the cash, limited to non-credential fields. */
export class AdminOrderCodCollectionCollectorDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;

  static fromEntity(
    collector: AdminOrderCodCollectionCollectorSource,
  ): AdminOrderCodCollectionCollectorDto {
    const dto = new AdminOrderCodCollectionCollectorDto();
    dto.id = collector.id;
    dto.firstName = collector.firstName;
    dto.lastName = collector.lastName;
    dto.email = collector.email;
    return dto;
  }
}

/**
 * The actual COD collection record attached to an order, if one exists.
 *
 * This is deliberately independent of `Payment`. A COD order normally has no
 * `Payment` row at all, so deriving collection from payment status would report
 * cash that was collected as unpaid. `status` is decided only by the presence of
 * a `cod_collections` row, never by the order or payment lifecycle.
 *
 * `null` is returned for a non-COD order that has no collection, so the admin UI
 * is never told a credit-card order was "not collected".
 */
export class AdminOrderCodCollectionDto {
  status: CodCollectionStatus;
  amount: string | null;
  currency: string | null;
  collectedAt: Date | null;
  collector: AdminOrderCodCollectionCollectorDto | null;

  static fromEntity(
    collection: AdminOrderCodCollectionSource,
  ): AdminOrderCodCollectionDto {
    const dto = new AdminOrderCodCollectionDto();
    dto.status = 'COLLECTED';
    dto.amount = toMoneyString(collection.amount);
    dto.currency = collection.currency;
    dto.collectedAt = collection.collectedAt;
    dto.collector = AdminOrderCodCollectionCollectorDto.fromEntity(
      collection.collectedBy,
    );
    return dto;
  }

  static notCollected(): AdminOrderCodCollectionDto {
    const dto = new AdminOrderCodCollectionDto();
    dto.status = 'NOT_COLLECTED';
    dto.amount = null;
    dto.currency = null;
    dto.collectedAt = null;
    dto.collector = null;
    return dto;
  }

  /**
   * Builds the collection summary from the order's own COD facts.
   *
   * A recorded collection wins even if the order's `paymentMethod` is unexpected,
   * because the row is financial evidence. A COD order with no row is
   * `NOT_COLLECTED`; any other order with no row gets `null`.
   */
  static fromOrder(
    paymentMethod: string | null,
    collections: readonly AdminOrderCodCollectionSource[] | undefined,
  ): AdminOrderCodCollectionDto | null {
    const collection = collections?.[0];

    if (collection !== undefined) {
      return AdminOrderCodCollectionDto.fromEntity(collection);
    }

    if (paymentMethod === 'COD') {
      return AdminOrderCodCollectionDto.notCollected();
    }

    return null;
  }
}
