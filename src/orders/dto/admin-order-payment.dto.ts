import { toMoneyString } from '../../common/utils/money.js';
import type { PaymentStatus } from '../../payments/constants/payment-status.constants.js';

/** The payment columns the listing is allowed to read and return. */
interface AdminOrderPaymentSummarySource {
  id: string;
  status: string;
  provider: string;
  amount: unknown;
  currency: string;
  paidAt: Date | null;
  createdAt: Date;
}

/** The summary fields one payment attempt contributes to the order listing. */
export class AdminOrderPaymentSummaryDto {
  id: string;
  status: PaymentStatus;
  provider: string;
  amount: string;
  currency: string;
  paidAt: Date | null;
  createdAt: Date;

  static fromEntity(
    payment: AdminOrderPaymentSummarySource,
  ): AdminOrderPaymentSummaryDto {
    const dto = new AdminOrderPaymentSummaryDto();

    dto.id = payment.id;
    dto.status = payment.status as PaymentStatus;
    dto.provider = payment.provider;
    dto.amount = toMoneyString(payment.amount);
    dto.currency = payment.currency;
    dto.paidAt = payment.paidAt;
    dto.createdAt = payment.createdAt;
    return dto;
  }
}

/** The safe detail of one payment attempt. */
export class AdminOrderPaymentDto extends AdminOrderPaymentSummaryDto {
  transactionId: string;
  paymentMethod: string | null;
  providerReference: string | null;

  static fromEntity(
    payment: AdminOrderPaymentSummarySource & {
      transactionId: string;
      paymentMethod: string | null;
      providerReference: string | null;
    },
  ): AdminOrderPaymentDto {
    const dto = new AdminOrderPaymentDto();
    const summary = AdminOrderPaymentSummaryDto.fromEntity(payment);

    Object.assign(dto, summary);
    dto.transactionId = payment.transactionId;
    dto.paymentMethod = payment.paymentMethod;
    dto.providerReference = payment.providerReference;
    return dto;
  }
}
