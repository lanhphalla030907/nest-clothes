import { toMoneyString } from '../../common/utils/money.js';

/**
 * Outbound representation of one COD collection record, as returned by
 * `GET /delivery/staff/cod-collections`.
 *
 * Money is a fixed two-decimal string so the figure cannot drift between the
 * database and the client. `collectedAt` is the collection reporting timestamp.
 */
export class CodCollectionResponseDto {
  collectionId: string;
  orderId: string;
  /** Customer-facing order reference, hydrated through the Prisma order relation. */
  orderNumber: string | null;
  amount: string;
  currency: string;
  collectedAt: Date;
  collectedById: string;
  notes: string | null;
  receiptProof: unknown | null;

  static fromEntity(entity: {
    id: string;
    orderId: string;
    order: { orderNumber: string | null } | null;
    amount: unknown;
    currency: string;
    collectedAt: Date;
    collectedById: string;
    notes: string | null;
    receiptProof: unknown | null;
  }): CodCollectionResponseDto {
    const dto = new CodCollectionResponseDto();
    dto.collectionId = entity.id;
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.order?.orderNumber ?? null;
    dto.amount = toMoneyString(entity.amount);
    dto.currency = entity.currency;
    dto.collectedAt = entity.collectedAt;
    dto.collectedById = entity.collectedById;
    dto.notes = entity.notes;
    dto.receiptProof = entity.receiptProof;
    return dto;
  }
}
