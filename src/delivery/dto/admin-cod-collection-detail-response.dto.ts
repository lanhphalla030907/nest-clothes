import { toMoneyString } from '../../common/utils/money.js';

/**
 * The administrative view of one COD collection.
 *
 * It carries the collection row, its order reference and the collecting delivery
 * staff member, plus the linked payment attempt when one exists. Customer PII is
 * deliberately absent — an operator needs the order and the money, not the buyer.
 */
export class AdminCodCollectionDetailResponseDto {
  collectionId: string;
  orderId: string;
  orderNumber: string | null;
  amount: string;
  currency: string;
  collectedAt: Date;
  notes: string | null;
  receiptProof: unknown | null;
  collectedById: string;
  collectedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  payment: {
    id: string;
    status: string;
    amount: string;
    currency: string;
    paymentMethod: string | null;
    paidAt: Date | null;
  } | null;

  static fromEntity(entity: {
    id: string;
    orderId: string;
    order: { orderNumber: string | null } | null;
    amount: unknown;
    currency: string;
    collectedAt: Date;
    notes: string | null;
    receiptProof: unknown | null;
    collectedById: string;
    collectedBy: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    };
    payment: {
      id: string;
      status: string;
      amount: unknown;
      currency: string;
      paymentMethod: string | null;
      paidAt: Date | null;
    } | null;
  }): AdminCodCollectionDetailResponseDto {
    const dto = new AdminCodCollectionDetailResponseDto();
    dto.collectionId = entity.id;
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.order?.orderNumber ?? null;
    dto.amount = toMoneyString(entity.amount);
    dto.currency = entity.currency;
    dto.collectedAt = entity.collectedAt;
    dto.notes = entity.notes;
    dto.receiptProof = entity.receiptProof;
    dto.collectedById = entity.collectedById;
    dto.collectedBy = entity.collectedBy;
    dto.payment =
      entity.payment === null
        ? null
        : {
            id: entity.payment.id,
            status: entity.payment.status,
            amount: toMoneyString(entity.payment.amount),
            currency: entity.payment.currency,
            paymentMethod: entity.payment.paymentMethod,
            paidAt: entity.payment.paidAt,
          };
    return dto;
  }
}
