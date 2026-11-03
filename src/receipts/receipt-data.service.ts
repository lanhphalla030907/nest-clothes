import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { toMoneyString } from '../common/utils/money.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { OrderRepository } from '../orders/repositories/order.repository.js';
import { OrderItemVariantOptionDto } from '../orders/dto/order-item-response.dto.js';
import type { AdminOrderDetailRow } from '../orders/repositories/order.repository.js';
import { PAYMENT_STATUS } from '../payments/constants/payment-status.constants.js';
import type { ReceiptOrderData } from './receipt.dto.js';
import { mapPaymentStatus } from './receipt.dto.js';

/**
 * Retrieves order data for receipt rendering through two authorization-safe paths.
 *
 * Both paths use `OrderRepository.findAdminById`, which returns the full order
 * projection including the customer relation, items, payments and COD
 * collections — everything a receipt needs in a single query.
 *
 * Customer path: after reading, checks that `order.userId === userId`. An order
 * owned by another user is indistinguishable from an absent one — both yield a
 * 404. No order row belonging to another customer is ever returned to the
 * caller.
 *
 * Admin path: reads any order by id, authorized by `RolesGuard` on the route
 * before this service is called. No ownership filter.
 *
 * Both paths return the same `ReceiptOrderData` shape so the PDF renderer has
 * one contract to satisfy.
 */
@Injectable()
export class ReceiptDataService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Customer path: returns receipt data only when the order exists and belongs
   * to `userId`. Throws 404 for nonexistent or unowned orders.
   */
  async getReceiptDataForCustomer(
    userId: string,
    orderId: string,
  ): Promise<ReceiptOrderData> {
    await this.requireUser(userId);

    const order = await this.orderRepository.findAdminById(orderId);

    if (order === null || order.userId !== userId) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return this.buildReceiptData(order);
  }

  /**
   * Admin path: returns receipt data for any order. Authorization is enforced
   * by `RolesGuard` (`@Roles(Role.ADMIN)`) on the controller route before this
   * method is reached.
   */
  async getReceiptDataForAdmin(orderId: string): Promise<ReceiptOrderData> {
    const order = await this.orderRepository.findAdminById(orderId);

    if (order === null) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return this.buildReceiptData(order);
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);

    if (user === null) {
      throw new NotFoundException(`User ${userId} not found`);
    }
  }

  private buildReceiptData(order: AdminOrderDetailRow): ReceiptOrderData {
    const attempts = (order.payments ?? []).map((p) => ({
      status: p.status as typeof PAYMENT_STATUS[keyof typeof PAYMENT_STATUS],
      amount: p.amount,
      currency: p.currency,
      paidAt: p.paidAt,
    }));

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status as ReceiptOrderData['orderStatus'],
      createdAt: order.createdAt.toISOString(),
      currency: order.currency,
      customer: {
        firstName: order.user?.firstName ?? '',
        lastName: order.user?.lastName ?? '',
        email: order.user?.email ?? '',
      },
      shipping: {
        recipientName: order.shippingRecipientName,
        phone: order.shippingPhone,
        addressLine1: order.shippingAddressLine1,
        addressLine2: order.shippingAddressLine2,
        city: order.shippingCity,
        stateProvince: order.shippingStateProvince,
        postalCode: order.shippingPostalCode,
        countryCode: order.shippingCountryCode,
        locationPath: (order.shippingLocationSnapshot as
          | ReceiptOrderData['shipping']['locationPath']
          | null) ?? null,
      },
      financial: {
        subtotal: toMoneyString(order.subtotal),
        shippingFee: toMoneyString(order.shippingFee),
        discountAmount: toMoneyString(order.discountAmount),
        totalAmount: toMoneyString(order.totalAmount),
      },
      items: order.items.map((item) => ({
        productName: item.productName,
        sku: item.sku,
        variantOptions: OrderItemVariantOptionDto.fromSnapshot(
          item.variantOptionsSnapshot,
        )
          .map((o: { optionName: string; optionValue: string }) => `${o.optionName}: ${o.optionValue}`)
          .join(', '),
        quantity: item.quantity,
        unitPrice: toMoneyString(item.unitPrice),
        lineTotal: toMoneyString(item.lineTotal),
      })),
      itemCount: order.items.reduce((t, i) => t + i.quantity, 0),
      payment: mapPaymentStatus(order.paymentMethod, attempts),
      codCollection: this.mapCodCollection(
        order.paymentMethod,
        order.codCollections ?? [],
      ),
    };
  }

  private mapCodCollection(
    paymentMethod: string | null,
    collections: Array<{
      amount: unknown;
      currency: string | null;
      collectedAt: Date | null;
      collectedBy: { firstName: string; lastName: string } | null;
    }>,
  ): ReceiptOrderData['codCollection'] | null {
    // Non-COD orders with no collection: codCollection is null.
    if (paymentMethod !== 'COD' && collections.length === 0) {
      return null;
    }

    const latest = collections.length > 0 ? collections[0] : null;

    if (latest === null) {
      // COD order, no collection row: not collected.
      return {
        status: 'NOT_COLLECTED',
        amount: null,
        currency: null,
        collectedAt: null,
        collector: null,
      };
    }

    return {
      status: 'COLLECTED',
      amount: toMoneyString(latest.amount),
      currency: latest.currency,
      collectedAt: latest.collectedAt === null ? null : latest.collectedAt.toISOString(),
      collector: latest.collectedBy === null
        ? null
        : {
            firstName: latest.collectedBy.firstName,
            lastName: latest.collectedBy.lastName,
          },
    };
  }
}
