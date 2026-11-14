import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryService } from './delivery.service.js';
import {
  DeliveryRepository,
  type DeliveryTransactionClient,
} from './repositories/delivery.repository.js';
import { DeliveryStatus, Role } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { vi } from 'vitest';

const MANAGER_ID = 'manager-1';
const ADMIN_ID = 'admin-1';
const STAFF_ID = 'staff-1';
const OTHER_STAFF_ID = 'staff-2';
const CUSTOMER_ID = 'customer-1';
const ORDER_ID = 'order-1';
const ASSIGNMENT_ID = 'assignment-1';

interface UserRow {
  id: string;
  role: Role;
  status: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface AssignmentRow {
  id: string;
  orderId: string;
  deliveryStaffId: string;
  status: DeliveryStatus;
  endedAt: Date | null;
}

interface RawAssignmentRow {
  id: string;
  order_id: string;
  delivery_staff_id: string;
  status: DeliveryStatus;
  ended_at: Date | null;
}

interface PaginatedAssignments {
  items: AssignmentRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function makeUser(
  id: string,
  role: Role,
  status: string = ACTIVE_USER_STATUS,
): UserRow {
  return {
    id,
    role,
    status,
    firstName: 'Test',
    lastName: 'User',
    email: `${id}@example.test`,
  };
}

function makeAssignment(
  overrides: Partial<AssignmentRow> &
    Pick<AssignmentRow, 'id' | 'deliveryStaffId'>,
): AssignmentRow {
  return {
    id: overrides.id,
    deliveryStaffId: overrides.deliveryStaffId,
    orderId: overrides.orderId ?? ORDER_ID,
    status: overrides.status ?? DeliveryStatus.ASSIGNED,
    endedAt: overrides.endedAt ?? null,
  };
}

function makeRawAssignment(
  overrides: Partial<RawAssignmentRow> &
    Pick<RawAssignmentRow, 'id' | 'delivery_staff_id'>,
): RawAssignmentRow {
  return {
    id: overrides.id,
    order_id: overrides.order_id ?? ORDER_ID,
    delivery_staff_id: overrides.delivery_staff_id,
    status: overrides.status ?? DeliveryStatus.ASSIGNED,
    ended_at: overrides.ended_at ?? null,
  };
}

interface TransactionHarness {
  tx: DeliveryTransactionClient;
  update: ReturnType<typeof vi.fn>;
}

function makeTransaction(
  rawRows: unknown[],
  currentAssignment: AssignmentRow | null = null,
): TransactionHarness {
  const update = vi.fn();
  update.mockResolvedValue({});

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(rawRows),
    deliveryAssignment: {
      findFirst: vi.fn().mockResolvedValue(currentAssignment),
      update,
    },
  };

  return { tx: tx as unknown as DeliveryTransactionClient, update };
}

describe('DeliveryService', () => {
  let service: DeliveryService;

  const mockRepository = {
    findUserById:
      vi.fn<
        (
          userId: string,
          tx?: DeliveryTransactionClient,
        ) => Promise<UserRow | null>
      >(),
    findActiveDeliveryStaff: vi.fn<() => Promise<UserRow[]>>(),
    createAssignment: vi.fn<
      (
        data: {
          orderId: string;
          deliveryStaffId: string;
          assignedById: string;
          status?: 'ASSIGNED' | 'PENDING_ASSIGNMENT';
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<AssignmentRow>
    >(),
    runInTransaction:
      vi.fn<
        (
          fn: (tx: DeliveryTransactionClient) => Promise<unknown>,
        ) => Promise<unknown>
      >(),
    findAssignmentById:
      vi.fn<
        (
          assignmentId: string,
          tx?: DeliveryTransactionClient,
        ) => Promise<AssignmentRow | null>
      >(),
    findAssignmentOrderId:
      vi.fn<(assignmentId: string) => Promise<string | null>>(),
    lockOrderForUpdate:
      vi.fn<
        (
          orderId: string,
          tx: DeliveryTransactionClient,
        ) => Promise<{ id: string } | null>
      >(),
    lockAssignmentForUpdate:
      vi.fn<
        (
          assignmentId: string,
          tx: DeliveryTransactionClient,
        ) => Promise<RawAssignmentRow | null>
      >(),
    transitionShippedOrderToDelivered:
      vi.fn<
        (orderId: string, tx: DeliveryTransactionClient) => Promise<boolean>
      >(),
    updateAssignmentStatus:
      vi.fn<
        (
          assignmentId: string,
          status: DeliveryStatus,
          notes?: string,
          tx?: DeliveryTransactionClient,
        ) => Promise<AssignmentRow>
      >(),
    findAssignmentsForStaff:
      vi.fn<
        (
          staffId: string,
          filters: { status?: DeliveryStatus; page?: number; limit?: number },
          tx?: DeliveryTransactionClient,
        ) => Promise<PaginatedAssignments>
      >(),
    findCodCollectionsForStaff: vi.fn<
      (
        staffId: string,
        filters: {
          startDate?: Date;
          endDate?: Date;
          currency?: string;
          orderId?: string;
          page?: number;
          limit?: number;
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<{
        items: unknown[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      }>
    >(),
    summarizeCodCollectionsForStaff: vi.fn<
      (
        staffId: string,
        filters: { startDate?: Date; endDate?: Date; currency?: string },
        tx?: DeliveryTransactionClient,
      ) => Promise<{
        totalsByCurrency: Array<{
          currency: string;
          totalAmount: unknown;
          count: number;
        }>;
        totalCollections: number;
        firstCollectionAt: Date | null;
        lastCollectionAt: Date | null;
      }>
    >(),
    summarizeCodCollectionsByPeriod: vi.fn<
      (
        staffId: string,
        filters: {
          startDate?: Date;
          endDate?: Date;
          currency?: string;
          period: 'daily' | 'weekly' | 'monthly';
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<
        Array<{
          period: string;
          currency: string;
          totalAmount: unknown;
          count: number;
        }>
      >
    >(),
    findCodCollectionsForAdmin: vi.fn<
      (
        filters: {
          startDate?: Date;
          endDate?: Date;
          staffId?: string;
          orderId?: string;
          orderNumber?: string;
          currency?: string;
          sortBy: string;
          sortOrder: string;
          page?: number;
          limit?: number;
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<{
        items: unknown[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      }>
    >(),
    findCodCollectionForAdminById: vi.fn<
      (
        collectionId: string,
        tx?: DeliveryTransactionClient,
      ) => Promise<{
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
        } | null;
        payment: {
          id: string;
          status: string;
          amount: unknown;
          currency: string;
          paymentMethod: string | null;
          paidAt: Date | null;
        } | null;
      } | null>
    >(),
    summarizeCodCollectionsForAdmin: vi.fn<
      (
        filters: {
          startDate?: Date;
          endDate?: Date;
          staffId?: string;
          orderId?: string;
          orderNumber?: string;
          currency?: string;
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<{
        totalsByCurrency: Array<{
          currency: string;
          totalAmount: unknown;
          count: number;
        }>;
        totalCollections: number;
        firstCollectionAt: Date | null;
        lastCollectionAt: Date | null;
      }>
    >(),
    summarizeCodCollectionsByPeriodForAdmin: vi.fn<
      (
        filters: {
          startDate?: Date;
          endDate?: Date;
          staffId?: string;
          orderId?: string;
          orderNumber?: string;
          currency?: string;
          period: 'daily' | 'weekly' | 'monthly';
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<
        Array<{
          period: string;
          currency: string;
          totalAmount: unknown;
          count: number;
        }>
      >
    >(),
    summarizeCodCollectionsByStaffForAdmin: vi.fn<
      (
        filters: {
          startDate?: Date;
          endDate?: Date;
          staffId?: string;
          orderId?: string;
          orderNumber?: string;
          currency?: string;
        },
        tx?: DeliveryTransactionClient,
      ) => Promise<
        Array<{
          staffId: string;
          staff: {
            id: string;
            firstName: string;
            lastName: string;
            email: string;
          } | null;
          currency: string;
          totalAmount: unknown;
          count: number;
        }>
      >
    >(),
    findCodReconciliationRecords: vi.fn(),
    summarizeCodReconciliation: vi.fn(),
    findUncollectedDeliveredCodOrders: vi.fn(),
    findCodReconciliationDiscrepancies: vi.fn(),
    summarizeCodReconciliationByStaff: vi.fn(),
    summarizeCodReconciliationByPeriod: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryService,
        { provide: DeliveryRepository, useValue: mockRepository },
        {
          provide: CloudinaryService,
          useValue: { upload: vi.fn(), deleteAsset: vi.fn() },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyOutForDelivery: vi.fn().mockResolvedValue(undefined),
            notifyOrderDelivered: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<DeliveryService>(DeliveryService);
  });

  describe('manager endpoints', () => {
    const managerRoles = [Role.DELIVERY_MANAGER, Role.ADMIN] as const;
    const blockedRoles = [Role.DELIVERY_STAFF, Role.CUSTOMER] as const;

    describe('assignDelivery', () => {
      const dto = { orderId: ORDER_ID, deliveryStaffId: STAFF_ID };

      it.each(blockedRoles)('blocks %s from assigning', async (role) => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(role === Role.DELIVERY_STAFF ? STAFF_ID : CUSTOMER_ID, role),
        );

        await expect(service.assignDelivery('actor', dto)).rejects.toThrow(
          ForbiddenException,
        );
        expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
      });

      it.each(managerRoles)('blocks an inactive %s', async (role) => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(
            role === Role.ADMIN ? ADMIN_ID : MANAGER_ID,
            role,
            'INACTIVE',
          ),
        );

        await expect(service.assignDelivery('actor', dto)).rejects.toThrow(
          ForbiddenException,
        );
        expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
      });

      it('blocks a manager that does not exist', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(null);

        await expect(service.assignDelivery('actor', dto)).rejects.toThrow(
          ForbiddenException,
        );
        expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
      });

      it.each(managerRoles)('allows an active %s to assign', async (role) => {
        const manager = makeUser(
          role === Role.ADMIN ? ADMIN_ID : MANAGER_ID,
          role,
        );
        mockRepository.findUserById
          .mockResolvedValueOnce(manager)
          .mockResolvedValueOnce(makeUser(STAFF_ID, Role.DELIVERY_STAFF));

        const created = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
        });
        mockRepository.createAssignment.mockResolvedValueOnce(created);

        const { tx } = makeTransaction([{ id: ORDER_ID, status: 'CONFIRMED' }]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(service.assignDelivery(manager.id, dto)).resolves.toEqual(
          created,
        );
        expect(mockRepository.createAssignment).toHaveBeenCalledWith(
          expect.objectContaining({ assignedById: manager.id }),
          tx,
        );
      });

      it('rejects an inactive delivery staff target', async () => {
        mockRepository.findUserById
          .mockResolvedValueOnce(makeUser(MANAGER_ID, Role.DELIVERY_MANAGER))
          .mockResolvedValueOnce(
            makeUser(STAFF_ID, Role.DELIVERY_STAFF, 'INACTIVE'),
          );

        const { tx } = makeTransaction([{ id: ORDER_ID, status: 'CONFIRMED' }]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(service.assignDelivery(MANAGER_ID, dto)).rejects.toThrow(
          BadRequestException,
        );
      });

      it('rejects a target user who is not delivery staff', async () => {
        mockRepository.findUserById
          .mockResolvedValueOnce(makeUser(MANAGER_ID, Role.DELIVERY_MANAGER))
          .mockResolvedValueOnce(makeUser(CUSTOMER_ID, Role.CUSTOMER));

        const { tx } = makeTransaction([{ id: ORDER_ID, status: 'CONFIRMED' }]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(service.assignDelivery(MANAGER_ID, dto)).rejects.toThrow(
          BadRequestException,
        );
      });

      it('rejects an order that is not eligible for assignment', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(MANAGER_ID, Role.DELIVERY_MANAGER),
        );

        const { tx } = makeTransaction([{ id: ORDER_ID, status: 'PENDING' }]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(service.assignDelivery(MANAGER_ID, dto)).rejects.toThrow(
          BadRequestException,
        );
      });
    });

    describe('reassignDelivery', () => {
      const dto = { deliveryStaffId: STAFF_ID };

      it.each(blockedRoles)('blocks %s from reassigning', async (role) => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(role === Role.DELIVERY_STAFF ? STAFF_ID : CUSTOMER_ID, role),
        );

        await expect(
          service.reassignDelivery('actor', ORDER_ID, dto),
        ).rejects.toThrow(ForbiddenException);
        expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
      });

      it.each(managerRoles)('blocks an inactive %s', async (role) => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(
            role === Role.ADMIN ? ADMIN_ID : MANAGER_ID,
            role,
            'INACTIVE',
          ),
        );

        await expect(
          service.reassignDelivery('actor', ORDER_ID, dto),
        ).rejects.toThrow(ForbiddenException);
        expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
      });

      it('blocks a manager that does not exist', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(null);

        await expect(
          service.reassignDelivery('actor', ORDER_ID, dto),
        ).rejects.toThrow(ForbiddenException);
        expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
      });

      it.each(managerRoles)('allows an active %s to reassign', async (role) => {
        const manager = makeUser(
          role === Role.ADMIN ? ADMIN_ID : MANAGER_ID,
          role,
        );
        mockRepository.findUserById
          .mockResolvedValueOnce(manager)
          .mockResolvedValueOnce(makeUser(STAFF_ID, Role.DELIVERY_STAFF));

        const created = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
        });
        mockRepository.createAssignment.mockResolvedValueOnce(created);

        const { tx } = makeTransaction([{ id: ORDER_ID, status: 'CONFIRMED' }]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.reassignDelivery(manager.id, ORDER_ID, dto),
        ).resolves.toEqual(created);
      });

      it.each([
        DeliveryStatus.OUT_FOR_DELIVERY,
        DeliveryStatus.DELIVERED,
        DeliveryStatus.RETURNED,
      ])('rejects reassignment from %s', async (status) => {
        mockRepository.findUserById
          .mockResolvedValueOnce(makeUser(MANAGER_ID, Role.DELIVERY_MANAGER))
          .mockResolvedValueOnce(makeUser(STAFF_ID, Role.DELIVERY_STAFF));

        const current = makeAssignment({
          id: 'previous-assignment',
          deliveryStaffId: OTHER_STAFF_ID,
          status,
        });
        const { tx } = makeTransaction(
          [{ id: ORDER_ID, status: 'CONFIRMED' }],
          current,
        );
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.reassignDelivery(MANAGER_ID, ORDER_ID, dto),
        ).rejects.toThrow(BadRequestException);
        expect(mockRepository.createAssignment).not.toHaveBeenCalled();
      });

      it('allows reassignment from FAILED_DELIVERY and ends the previous assignment', async () => {
        mockRepository.findUserById
          .mockResolvedValueOnce(makeUser(MANAGER_ID, Role.DELIVERY_MANAGER))
          .mockResolvedValueOnce(makeUser(STAFF_ID, Role.DELIVERY_STAFF));

        const created = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
        });
        mockRepository.createAssignment.mockResolvedValueOnce(created);

        const current = makeAssignment({
          id: 'previous-assignment',
          deliveryStaffId: OTHER_STAFF_ID,
          status: DeliveryStatus.FAILED_DELIVERY,
        });
        const { tx, update } = makeTransaction(
          [{ id: ORDER_ID, status: 'CONFIRMED' }],
          current,
        );
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.reassignDelivery(MANAGER_ID, ORDER_ID, dto),
        ).resolves.toEqual(created);
        expect(update).toHaveBeenCalledWith({
          where: { id: current.id },
          data: { endedAt: expect.any(Date) },
        });
      });

      it('ends the previous assignment when reassigning from ASSIGNED', async () => {
        mockRepository.findUserById
          .mockResolvedValueOnce(makeUser(MANAGER_ID, Role.DELIVERY_MANAGER))
          .mockResolvedValueOnce(makeUser(STAFF_ID, Role.DELIVERY_STAFF));

        const created = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
        });
        mockRepository.createAssignment.mockResolvedValueOnce(created);

        const current = makeAssignment({
          id: 'previous-assignment',
          deliveryStaffId: OTHER_STAFF_ID,
          status: DeliveryStatus.ASSIGNED,
        });
        const { tx, update } = makeTransaction(
          [{ id: ORDER_ID, status: 'CONFIRMED' }],
          current,
        );
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.reassignDelivery(MANAGER_ID, ORDER_ID, dto),
        ).resolves.toEqual(created);
        expect(update).toHaveBeenCalled();
      });
    });
  });

  describe('staff endpoints', () => {
    const blockedActors: Array<[Role, string]> = [
      [Role.ADMIN, ACTIVE_USER_STATUS],
      [Role.DELIVERY_MANAGER, ACTIVE_USER_STATUS],
      [Role.CUSTOMER, ACTIVE_USER_STATUS],
      [Role.DELIVERY_STAFF, 'INACTIVE'],
    ];

    describe('getMyAssignments', () => {
      it('allows an active delivery staff member to list only their assignments', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.findAssignmentsForStaff.mockResolvedValueOnce({
          items: [],
          total: 0,
          page: 1,
          limit: 20,
          totalPages: 0,
        });

        await expect(service.getMyAssignments(STAFF_ID, {})).resolves.toEqual({
          items: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
        expect(mockRepository.findAssignmentsForStaff).toHaveBeenCalledWith(
          STAFF_ID,
          { status: undefined, page: undefined, limit: undefined },
        );
      });

      it.each(blockedActors)(
        'blocks %s with status %s from listing assignments',
        async (role, status) => {
          mockRepository.findUserById.mockResolvedValueOnce(
            makeUser('actor', role, status),
          );

          await expect(service.getMyAssignments('actor', {})).rejects.toThrow(
            ForbiddenException,
          );
          expect(mockRepository.findAssignmentsForStaff).not.toHaveBeenCalled();
        },
      );
    });

    describe('getMyAssignment', () => {
      it('allows an active delivery staff member to read their own assignment', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        const assignment = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
        });
        mockRepository.findAssignmentById.mockResolvedValueOnce(assignment);

        await expect(
          service.getMyAssignment(STAFF_ID, ASSIGNMENT_ID),
        ).resolves.toEqual(assignment);
      });

      it('prevents staff from reading another staff member assignment', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.findAssignmentById.mockResolvedValueOnce(
          makeAssignment({
            id: ASSIGNMENT_ID,
            deliveryStaffId: OTHER_STAFF_ID,
          }),
        );

        await expect(
          service.getMyAssignment(STAFF_ID, ASSIGNMENT_ID),
        ).rejects.toThrow(ForbiddenException);
      });

      it.each(blockedActors)(
        'blocks %s with status %s from reading an assignment',
        async (role, status) => {
          mockRepository.findUserById.mockResolvedValueOnce(
            makeUser('actor', role, status),
          );

          await expect(
            service.getMyAssignment('actor', ASSIGNMENT_ID),
          ).rejects.toThrow(ForbiddenException);
          expect(mockRepository.findAssignmentById).not.toHaveBeenCalled();
        },
      );
    });

    describe('updateMyAssignmentStatus', () => {
      const dto = { status: DeliveryStatus.OUT_FOR_DELIVERY };

      it('allows an active delivery staff member to update their own assignment', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        const updated = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
          status: DeliveryStatus.OUT_FOR_DELIVERY,
        });
        mockRepository.updateAssignmentStatus.mockResolvedValueOnce(updated);

        const current = makeRawAssignment({
          id: ASSIGNMENT_ID,
          delivery_staff_id: STAFF_ID,
          status: DeliveryStatus.ASSIGNED,
        });
        const { tx } = makeTransaction([current]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.updateMyAssignmentStatus(STAFF_ID, ASSIGNMENT_ID, dto),
        ).resolves.toEqual(updated);
        expect(mockRepository.updateAssignmentStatus).toHaveBeenCalledWith(
          ASSIGNMENT_ID,
          DeliveryStatus.OUT_FOR_DELIVERY,
          undefined,
          tx,
        );
      });

      it('marks a shipped order delivered with its assignment in the same transaction', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.findAssignmentOrderId.mockResolvedValueOnce(ORDER_ID);
        mockRepository.lockOrderForUpdate.mockResolvedValueOnce({
          id: ORDER_ID,
        });
        mockRepository.lockAssignmentForUpdate.mockResolvedValueOnce(
          makeRawAssignment({
            id: ASSIGNMENT_ID,
            order_id: ORDER_ID,
            delivery_staff_id: STAFF_ID,
            status: DeliveryStatus.OUT_FOR_DELIVERY,
          }),
        );
        mockRepository.transitionShippedOrderToDelivered.mockResolvedValueOnce(
          true,
        );
        const updated = makeAssignment({
          id: ASSIGNMENT_ID,
          deliveryStaffId: STAFF_ID,
          status: DeliveryStatus.DELIVERED,
        });
        mockRepository.updateAssignmentStatus.mockResolvedValueOnce(updated);
        const { tx } = makeTransaction([]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.updateMyAssignmentStatus(STAFF_ID, ASSIGNMENT_ID, {
            status: DeliveryStatus.DELIVERED,
          }),
        ).resolves.toEqual(updated);
        expect(mockRepository.lockOrderForUpdate).toHaveBeenCalledWith(
          ORDER_ID,
          tx,
        );
        expect(
          mockRepository.transitionShippedOrderToDelivered,
        ).toHaveBeenCalledWith(ORDER_ID, tx);
        expect(mockRepository.updateAssignmentStatus).toHaveBeenCalledWith(
          ASSIGNMENT_ID,
          DeliveryStatus.DELIVERED,
          undefined,
          tx,
        );
        expect(
          mockRepository.transitionShippedOrderToDelivered.mock
            .invocationCallOrder[0],
        ).toBeLessThan(
          mockRepository.updateAssignmentStatus.mock.invocationCallOrder[0],
        );
      });

      it('does not deliver an assignment when its order is not SHIPPED', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.findAssignmentOrderId.mockResolvedValueOnce(ORDER_ID);
        mockRepository.lockOrderForUpdate.mockResolvedValueOnce({
          id: ORDER_ID,
        });
        mockRepository.lockAssignmentForUpdate.mockResolvedValueOnce(
          makeRawAssignment({
            id: ASSIGNMENT_ID,
            delivery_staff_id: STAFF_ID,
            status: DeliveryStatus.OUT_FOR_DELIVERY,
          }),
        );
        mockRepository.transitionShippedOrderToDelivered.mockResolvedValueOnce(
          false,
        );
        const { tx } = makeTransaction([]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.updateMyAssignmentStatus(STAFF_ID, ASSIGNMENT_ID, {
            status: DeliveryStatus.DELIVERED,
          }),
        ).rejects.toThrow(ConflictException);
        expect(mockRepository.updateAssignmentStatus).not.toHaveBeenCalled();
      });

      it('prevents staff from updating another staff member assignment', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );

        const current = makeRawAssignment({
          id: ASSIGNMENT_ID,
          delivery_staff_id: OTHER_STAFF_ID,
          status: DeliveryStatus.ASSIGNED,
        });
        const { tx } = makeTransaction([current]);
        mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
          fn(tx),
        );

        await expect(
          service.updateMyAssignmentStatus(STAFF_ID, ASSIGNMENT_ID, dto),
        ).rejects.toThrow(ForbiddenException);
        expect(mockRepository.updateAssignmentStatus).not.toHaveBeenCalled();
      });

      it.each(blockedActors)(
        'blocks %s with status %s from updating an assignment',
        async (role, status) => {
          mockRepository.findUserById.mockResolvedValueOnce(
            makeUser('actor', role, status),
          );

          await expect(
            service.updateMyAssignmentStatus('actor', ASSIGNMENT_ID, dto),
          ).rejects.toThrow(ForbiddenException);
          expect(mockRepository.runInTransaction).not.toHaveBeenCalled();
        },
      );
    });

    describe('getMyCodCollections', () => {
      const collectionRow = {
        id: 'collection-1',
        orderId: ORDER_ID,
        order: {
          id: ORDER_ID,
          orderNumber: 'ORD-1',
          status: 'CONFIRMED',
          paymentMethod: 'COD',
          totalAmount: '10.00',
          currency: 'USD',
        },
        amount: '10.00',
        currency: 'USD',
        collectedAt: new Date('2026-01-02T10:00:00Z'),
        collectedById: STAFF_ID,
        notes: 'Cash received',
        receiptProof: null,
      };

      it('allows an active delivery staff member to list only their collections', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.findCodCollectionsForStaff.mockResolvedValueOnce({
          items: [collectionRow],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
        });

        await expect(
          service.getMyCodCollections(STAFF_ID, {}),
        ).resolves.toEqual({
          items: [
            {
              collectionId: 'collection-1',
              orderId: ORDER_ID,
              orderNumber: 'ORD-1',
              amount: '10.00',
              currency: 'USD',
              collectedAt: collectionRow.collectedAt,
              collectedById: STAFF_ID,
              notes: 'Cash received',
              receiptProof: null,
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        });
        expect(mockRepository.findCodCollectionsForStaff).toHaveBeenCalledWith(
          STAFF_ID,
          {
            startDate: undefined,
            endDate: undefined,
            currency: undefined,
            orderId: undefined,
            page: undefined,
            limit: undefined,
          },
        );
      });

      it('passes pagination, date, currency and order filters to the repository', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.findCodCollectionsForStaff.mockResolvedValueOnce({
          items: [],
          total: 0,
          page: 2,
          limit: 5,
          totalPages: 0,
        });

        await expect(
          service.getMyCodCollections(STAFF_ID, {
            page: 2,
            limit: 5,
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            currency: 'KHR',
            orderId: ORDER_ID,
          }),
        ).resolves.toEqual({
          items: [],
          pagination: { page: 2, limit: 5, total: 0, totalPages: 0 },
        });
        expect(mockRepository.findCodCollectionsForStaff).toHaveBeenCalledWith(
          STAFF_ID,
          {
            startDate: new Date(Date.UTC(2026, 0, 1)),
            endDate: new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999)),
            currency: 'KHR',
            orderId: ORDER_ID,
            page: 2,
            limit: 5,
          },
        );
      });

      it('rejects a startDate after endDate', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );

        await expect(
          service.getMyCodCollections(STAFF_ID, {
            startDate: '2026-02-01',
            endDate: '2026-01-01',
          }),
        ).rejects.toThrow(BadRequestException);
        expect(
          mockRepository.findCodCollectionsForStaff,
        ).not.toHaveBeenCalled();
      });

      it.each(blockedActors)(
        'blocks %s with status %s from listing collections',
        async (role, status) => {
          mockRepository.findUserById.mockResolvedValueOnce(
            makeUser('actor', role, status),
          );

          await expect(
            service.getMyCodCollections('actor', {}),
          ).rejects.toThrow(ForbiddenException);
          expect(
            mockRepository.findCodCollectionsForStaff,
          ).not.toHaveBeenCalled();
        },
      );
    });

    describe('getMyCodCollectionsSummary', () => {
      it('allows an active delivery staff member to read their own summary', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.summarizeCodCollectionsForStaff.mockResolvedValueOnce({
          totalsByCurrency: [
            { currency: 'USD', totalAmount: '1250.00', count: 20 },
            { currency: 'KHR', totalAmount: '200000', count: 5 },
          ],
          totalCollections: 25,
          firstCollectionAt: new Date('2026-01-01T00:00:00Z'),
          lastCollectionAt: new Date('2026-01-31T23:59:59Z'),
        });
        mockRepository.summarizeCodCollectionsByPeriod.mockResolvedValueOnce(
          [],
        );

        await expect(
          service.getMyCodCollectionsSummary(STAFF_ID, {}),
        ).resolves.toEqual({
          totalCollections: 25,
          totalsByCurrency: [
            { currency: 'USD', totalAmount: '1250.00', count: 20 },
            { currency: 'KHR', totalAmount: '200000.00', count: 5 },
          ],
          firstCollectionAt: new Date('2026-01-01T00:00:00Z'),
          lastCollectionAt: new Date('2026-01-31T23:59:59Z'),
          periodBreakdown: [],
        });
        expect(
          mockRepository.summarizeCodCollectionsForStaff,
        ).toHaveBeenCalledWith(STAFF_ID, {
          startDate: undefined,
          endDate: undefined,
          currency: undefined,
        });
      });

      it('keeps multiple currencies separated and never mixes them into one total', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.summarizeCodCollectionsForStaff.mockResolvedValueOnce({
          totalsByCurrency: [
            { currency: 'USD', totalAmount: '100.00', count: 1 },
            { currency: 'KHR', totalAmount: '400000', count: 2 },
          ],
          totalCollections: 3,
          firstCollectionAt: null,
          lastCollectionAt: null,
        });
        mockRepository.summarizeCodCollectionsByPeriod.mockResolvedValueOnce(
          [],
        );

        await expect(
          service.getMyCodCollectionsSummary(STAFF_ID, {}),
        ).resolves.toEqual({
          totalCollections: 3,
          totalsByCurrency: [
            { currency: 'USD', totalAmount: '100.00', count: 1 },
            { currency: 'KHR', totalAmount: '400000.00', count: 2 },
          ],
          firstCollectionAt: null,
          lastCollectionAt: null,
          periodBreakdown: [],
        });
      });

      it('requests a period breakdown when period is supplied', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );
        mockRepository.summarizeCodCollectionsForStaff.mockResolvedValueOnce({
          totalsByCurrency: [],
          totalCollections: 0,
          firstCollectionAt: null,
          lastCollectionAt: null,
        });
        const breakdown = [
          {
            period: '2026-01-05',
            currency: 'USD',
            totalAmount: '10.00',
            count: 1,
          },
        ];
        mockRepository.summarizeCodCollectionsByPeriod.mockResolvedValueOnce(
          breakdown,
        );

        await expect(
          service.getMyCodCollectionsSummary(STAFF_ID, { period: 'daily' }),
        ).resolves.toEqual({
          totalCollections: 0,
          totalsByCurrency: [],
          firstCollectionAt: null,
          lastCollectionAt: null,
          periodBreakdown: breakdown,
        });
        expect(
          mockRepository.summarizeCodCollectionsByPeriod,
        ).toHaveBeenCalledWith(STAFF_ID, {
          startDate: undefined,
          endDate: undefined,
          currency: undefined,
          period: 'daily',
        });
      });

      it('rejects a startDate after endDate', async () => {
        mockRepository.findUserById.mockResolvedValueOnce(
          makeUser(STAFF_ID, Role.DELIVERY_STAFF),
        );

        await expect(
          service.getMyCodCollectionsSummary(STAFF_ID, {
            startDate: '2026-02-01',
            endDate: '2026-01-01',
          }),
        ).rejects.toThrow(BadRequestException);
        expect(
          mockRepository.summarizeCodCollectionsForStaff,
        ).not.toHaveBeenCalled();
      });

      it.each(blockedActors)(
        'blocks %s with status %s from reading the summary',
        async (role, status) => {
          mockRepository.findUserById.mockResolvedValueOnce(
            makeUser('actor', role, status),
          );

          await expect(
            service.getMyCodCollectionsSummary('actor', {}),
          ).rejects.toThrow(ForbiddenException);
          expect(
            mockRepository.summarizeCodCollectionsForStaff,
          ).not.toHaveBeenCalled();
        },
      );
    });

    describe('admin endpoints', () => {
      const adminCollectionRow = {
        id: 'collection-1',
        orderId: ORDER_ID,
        order: { id: ORDER_ID, orderNumber: 'ORD-1' },
        amount: '10.00',
        currency: 'USD',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
        collectedById: STAFF_ID,
        collectedBy: {
          id: STAFF_ID,
          firstName: 'COD',
          lastName: 'Staff A',
          email: 'staff-a@example.test',
        },
        notes: null,
        receiptProof: null,
        payment: null,
      };

      it('lets an administrator list every collection with pagination', async () => {
        mockRepository.findCodCollectionsForAdmin.mockResolvedValueOnce({
          items: [adminCollectionRow],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
        });

        await expect(
          service.getCodCollectionsForAdmin({
            page: 1,
            limit: 20,
            sortBy: 'collectedAt',
            sortOrder: 'desc',
          }),
        ).resolves.toEqual({
          items: [
            {
              collectionId: 'collection-1',
              orderId: ORDER_ID,
              orderNumber: 'ORD-1',
              amount: '10.00',
              currency: 'USD',
              collectedAt: adminCollectionRow.collectedAt,
              collectedById: STAFF_ID,
              collectedBy: adminCollectionRow.collectedBy,
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        });
        expect(mockRepository.findCodCollectionsForAdmin).toHaveBeenCalledWith({
          startDate: undefined,
          endDate: undefined,
          staffId: undefined,
          orderId: undefined,
          orderNumber: undefined,
          currency: undefined,
          sortBy: 'collectedAt',
          sortOrder: 'desc',
          page: 1,
          limit: 20,
        });
      });

      it('returns collection details for an administrator', async () => {
        mockRepository.findCodCollectionForAdminById.mockResolvedValueOnce(
          adminCollectionRow,
        );

        await expect(
          service.getCodCollectionForAdminById('collection-1'),
        ).resolves.toEqual({
          collectionId: 'collection-1',
          orderId: ORDER_ID,
          orderNumber: 'ORD-1',
          amount: '10.00',
          currency: 'USD',
          collectedAt: adminCollectionRow.collectedAt,
          notes: null,
          receiptProof: null,
          collectedById: STAFF_ID,
          collectedBy: adminCollectionRow.collectedBy,
          payment: null,
        });
      });

      it('returns 404 for a missing collection', async () => {
        mockRepository.findCodCollectionForAdminById.mockResolvedValueOnce(
          null,
        );

        await expect(
          service.getCodCollectionForAdminById('missing-collection'),
        ).rejects.toThrow(NotFoundException);
      });

      it('calculates a global summary with staff and period breakdowns', async () => {
        mockRepository.summarizeCodCollectionsForAdmin.mockResolvedValueOnce({
          totalsByCurrency: [
            { currency: 'USD', totalAmount: '100.00', count: 2 },
            { currency: 'KHR', totalAmount: '400000', count: 1 },
          ],
          totalCollections: 3,
          firstCollectionAt: new Date('2026-01-05T10:00:00Z'),
          lastCollectionAt: new Date('2026-01-10T10:00:00Z'),
        });
        mockRepository.summarizeCodCollectionsByPeriodForAdmin.mockResolvedValueOnce(
          [
            {
              period: '2026-01-05',
              currency: 'USD',
              totalAmount: '100.00',
              count: 2,
            },
          ],
        );
        mockRepository.summarizeCodCollectionsByStaffForAdmin.mockResolvedValueOnce(
          [
            {
              staffId: STAFF_ID,
              staff: adminCollectionRow.collectedBy,
              currency: 'USD',
              totalAmount: '100.00',
              count: 2,
            },
          ],
        );

        await expect(
          service.getCodCollectionsSummaryForAdmin({
            page: 1,
            limit: 20,
            period: 'daily',
          }),
        ).resolves.toEqual({
          totalCollections: 3,
          totalsByCurrency: [
            { currency: 'USD', totalAmount: '100.00', count: 2 },
            { currency: 'KHR', totalAmount: '400000.00', count: 1 },
          ],
          firstCollectionAt: new Date('2026-01-05T10:00:00Z'),
          lastCollectionAt: new Date('2026-01-10T10:00:00Z'),
          periodBreakdown: [
            {
              period: '2026-01-05',
              currency: 'USD',
              totalAmount: '100.00',
              count: 2,
            },
          ],
          staffBreakdown: [
            {
              staffId: STAFF_ID,
              staff: adminCollectionRow.collectedBy,
              currency: 'USD',
              totalAmount: '100.00',
              count: 2,
            },
          ],
        });
        expect(
          mockRepository.summarizeCodCollectionsByPeriodForAdmin,
        ).toHaveBeenCalledWith(expect.objectContaining({ period: 'daily' }));
      });

      it('rejects a startDate after endDate on the summary', async () => {
        await expect(
          service.getCodCollectionsSummaryForAdmin({
            page: 1,
            limit: 20,
            startDate: '2026-02-01',
            endDate: '2026-01-01',
          }),
        ).rejects.toThrow(BadRequestException);
        expect(
          mockRepository.summarizeCodCollectionsForAdmin,
        ).not.toHaveBeenCalled();
      });
    });
  });

  describe('COD financial reconciliation', () => {
    const deliveredAt = new Date('2026-10-15T10:00:00Z');
    const collectedAt = new Date('2026-10-15T10:05:00Z');
    const collector = {
      id: STAFF_ID,
      firstName: 'COD',
      lastName: 'Collector',
      email: 'collector@example.test',
    };
    const courier = {
      id: OTHER_STAFF_ID,
      firstName: 'Delivery',
      lastName: 'Courier',
      email: 'courier@example.test',
    };

    const recordRow = {
      orderId: ORDER_ID,
      orderNumber: 'ORD-1',
      orderStatus: 'DELIVERED',
      paymentMethod: 'COD',
      totalAmount: new Prisma.Decimal('100.00'),
      expectedAmount: new Prisma.Decimal('100.00'),
      currency: 'USD',
      collectedAmount: new Prisma.Decimal('100.00'),
      collectionId: 'collection-1',
      collectedAt,
      collectedById: STAFF_ID,
      collectedBy: collector,
      deliveryStaffId: OTHER_STAFF_ID,
      deliveryStaff: courier,
      deliveredAt,
      discrepancy: false,
      discrepancyType: null,
    };

    it('maps reconciliation records to DTO strings and forwards filters and pagination', async () => {
      mockRepository.findCodReconciliationRecords.mockResolvedValueOnce({
        items: [recordRow],
        total: 1,
        page: 2,
        limit: 5,
        totalPages: 1,
      });

      await expect(
        service.getCodReconciliationRecords({
          page: 2,
          limit: 5,
          startDate: '2026-10-01',
          endDate: '2026-10-31',
          staffId: STAFF_ID,
          orderId: ORDER_ID,
          orderNumber: 'ORD',
          status: 'DELIVERED',
          currency: 'USD',
          sortBy: 'collectedAt',
          sortOrder: 'asc',
        }),
      ).resolves.toEqual({
        items: [
          {
            orderId: ORDER_ID,
            orderNumber: 'ORD-1',
            orderStatus: 'DELIVERED',
            paymentMethod: 'COD',
            expectedAmount: '100.00',
            currency: 'USD',
            collectedAmount: '100.00',
            collectionId: 'collection-1',
            collectedAt,
            collectedById: STAFF_ID,
            collectedBy: collector,
            discrepancy: false,
          },
        ],
        pagination: { page: 2, limit: 5, total: 1, totalPages: 1 },
      });

      expect(mockRepository.findCodReconciliationRecords).toHaveBeenCalledWith({
        startDate: new Date(Date.UTC(2026, 9, 1)),
        endDate: new Date(Date.UTC(2026, 9, 31, 23, 59, 59, 999)),
        staffId: STAFF_ID,
        orderId: ORDER_ID,
        orderNumber: 'ORD',
        status: 'DELIVERED',
        currency: 'USD',
        sortBy: 'collectedAt',
        sortOrder: 'asc',
        period: undefined,
        page: 2,
        limit: 5,
      });
    });

    it('returns an empty reconciliation record page', async () => {
      mockRepository.findCodReconciliationRecords.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      await expect(
        service.getCodReconciliationRecords({ page: 1, limit: 20 }),
      ).resolves.toEqual({
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('maps a multi-currency summary without mixing currencies', async () => {
      mockRepository.summarizeCodReconciliation.mockResolvedValueOnce({
        totalCollections: 3,
        totalsByCurrency: [
          {
            currency: 'USD',
            collectedAmount: new Prisma.Decimal('100.00'),
            expectedAmount: new Prisma.Decimal('120.00'),
            outstandingAmount: new Prisma.Decimal('20.00'),
            count: 2,
          },
          {
            currency: 'KHR',
            collectedAmount: new Prisma.Decimal('400000.00'),
            expectedAmount: new Prisma.Decimal('0.00'),
            outstandingAmount: new Prisma.Decimal('0.00'),
            count: 1,
          },
        ],
        expectedAmountByCurrency: [
          { currency: 'USD', totalAmount: new Prisma.Decimal('120.00') },
          { currency: 'KHR', totalAmount: new Prisma.Decimal('0.00') },
        ],
        outstandingAmountByCurrency: [
          { currency: 'USD', totalAmount: new Prisma.Decimal('20.00') },
          { currency: 'KHR', totalAmount: new Prisma.Decimal('0.00') },
        ],
        collectionCount: 3,
        discrepancyCount: 1,
        firstCollectionAt: collectedAt,
        lastCollectionAt: collectedAt,
        periodBreakdown: [
          {
            period: '2026-10-15',
            currency: 'USD',
            collectedAmount: new Prisma.Decimal('100.00'),
            expectedAmount: new Prisma.Decimal('120.00'),
            outstandingAmount: new Prisma.Decimal('20.00'),
            count: 2,
          },
        ],
        staffBreakdown: [
          {
            staffId: STAFF_ID,
            staff: collector,
            currency: 'USD',
            collectedAmount: new Prisma.Decimal('100.00'),
            expectedAmount: new Prisma.Decimal('120.00'),
            outstandingAmount: new Prisma.Decimal('20.00'),
            count: 2,
          },
        ],
      });

      const result = await service.getCodReconciliationSummary({
        page: 1,
        limit: 20,
        currency: 'USD',
        period: 'monthly',
      });

      expect(result.totalCollections).toBe(3);
      expect(result.collectionCount).toBe(3);
      expect(result.discrepancyCount).toBe(1);
      expect(result.totalsByCurrency).toEqual([
        {
          currency: 'USD',
          collectedAmount: '100.00',
          expectedAmount: '120.00',
          outstandingAmount: '20.00',
          count: 2,
        },
        {
          currency: 'KHR',
          collectedAmount: '400000.00',
          expectedAmount: '0.00',
          outstandingAmount: '0.00',
          count: 1,
        },
      ]);
      expect(result.expectedAmountByCurrency).toEqual([
        { currency: 'USD', totalAmount: '120.00' },
        { currency: 'KHR', totalAmount: '0.00' },
      ]);
      expect(result.outstandingAmountByCurrency).toEqual([
        { currency: 'USD', totalAmount: '20.00' },
        { currency: 'KHR', totalAmount: '0.00' },
      ]);
      expect(result.periodBreakdown[0]).toEqual({
        period: '2026-10-15',
        currency: 'USD',
        collectedAmount: '100.00',
        expectedAmount: '120.00',
        outstandingAmount: '20.00',
        count: 2,
      });
      expect(result.staffBreakdown[0]).toEqual({
        staffId: STAFF_ID,
        staff: collector,
        currency: 'USD',
        collectedAmount: '100.00',
        expectedAmount: '120.00',
        outstandingAmount: '20.00',
        count: 2,
      });
      expect(mockRepository.summarizeCodReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'USD',
          period: 'monthly',
          startDate: undefined,
          endDate: undefined,
        }),
      );
    });

    it('returns an empty summary when there is no reconciliation data', async () => {
      mockRepository.summarizeCodReconciliation.mockResolvedValueOnce({
        totalCollections: 0,
        totalsByCurrency: [],
        expectedAmountByCurrency: [],
        outstandingAmountByCurrency: [],
        collectionCount: 0,
        discrepancyCount: 0,
        firstCollectionAt: null,
        lastCollectionAt: null,
        periodBreakdown: [],
        staffBreakdown: [],
      });

      await expect(
        service.getCodReconciliationSummary({ page: 1, limit: 20 }),
      ).resolves.toEqual({
        totalCollections: 0,
        totalsByCurrency: [],
        expectedAmountByCurrency: [],
        outstandingAmountByCurrency: [],
        collectionCount: 0,
        discrepancyCount: 0,
        firstCollectionAt: null,
        lastCollectionAt: null,
        periodBreakdown: [],
        staffBreakdown: [],
      });
    });

    it('lists uncollected delivered COD orders with string amounts and pagination', async () => {
      mockRepository.findUncollectedDeliveredCodOrders.mockResolvedValueOnce({
        items: [
          {
            orderId: ORDER_ID,
            orderNumber: 'ORD-UNCOLLECTED',
            orderStatus: 'DELIVERED',
            totalAmount: new Prisma.Decimal('60.00'),
            expectedAmount: new Prisma.Decimal('60.00'),
            currency: 'USD',
            deliveryStaffId: OTHER_STAFF_ID,
            deliveryStaff: courier,
            deliveredAt,
          },
        ],
        total: 1,
        page: 3,
        limit: 10,
        totalPages: 1,
      });

      await expect(
        service.getUncollectedDeliveredCodOrders({
          page: 3,
          limit: 10,
          staffId: OTHER_STAFF_ID,
        }),
      ).resolves.toEqual({
        items: [
          {
            orderId: ORDER_ID,
            orderNumber: 'ORD-UNCOLLECTED',
            orderStatus: 'DELIVERED',
            expectedAmount: '60.00',
            currency: 'USD',
            deliveryStaffId: OTHER_STAFF_ID,
            deliveryStaff: courier,
            deliveredAt,
          },
        ],
        pagination: { page: 3, limit: 10, total: 1, totalPages: 1 },
      });
      expect(
        mockRepository.findUncollectedDeliveredCodOrders,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          staffId: OTHER_STAFF_ID,
          page: 3,
          limit: 10,
        }),
      );
    });

    it('returns an empty uncollected listing', async () => {
      mockRepository.findUncollectedDeliveredCodOrders.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      await expect(
        service.getUncollectedDeliveredCodOrders({ page: 1, limit: 20 }),
      ).resolves.toEqual({
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('keeps missing-collection and currency-mismatch discrepancies distinct', async () => {
      mockRepository.findCodReconciliationDiscrepancies.mockResolvedValueOnce({
        items: [
          {
            orderId: ORDER_ID,
            orderNumber: 'ORD-MISSING',
            orderStatus: 'DELIVERED',
            discrepancyType: 'missing-collection',
            totalAmount: new Prisma.Decimal('50.00'),
            expectedAmount: new Prisma.Decimal('50.00'),
            collectedAmount: null,
            actualAmount: null,
            currency: 'USD',
            collectionId: null,
          },
          {
            orderId: 'order-2',
            orderNumber: 'ORD-CURRENCY',
            orderStatus: 'DELIVERED',
            discrepancyType: 'currency-mismatch',
            totalAmount: new Prisma.Decimal('40.00'),
            expectedAmount: new Prisma.Decimal('40.00'),
            collectedAmount: new Prisma.Decimal('160000.00'),
            actualAmount: new Prisma.Decimal('160000.00'),
            currency: 'USD',
            collectionId: 'collection-2',
          },
        ],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const result = await service.getCodReconciliationDiscrepancies({
        page: 1,
        limit: 20,
        orderId: ORDER_ID,
      });

      expect(result.items).toEqual([
        {
          orderId: ORDER_ID,
          orderNumber: 'ORD-MISSING',
          orderStatus: 'DELIVERED',
          discrepancyType: 'missing-collection',
          expectedAmount: '50.00',
          actualAmount: null,
          currency: 'USD',
          collectionId: null,
        },
        {
          orderId: 'order-2',
          orderNumber: 'ORD-CURRENCY',
          orderStatus: 'DELIVERED',
          discrepancyType: 'currency-mismatch',
          expectedAmount: '40.00',
          actualAmount: '160000.00',
          currency: 'USD',
          collectionId: 'collection-2',
        },
      ]);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('returns an empty discrepancy listing', async () => {
      mockRepository.findCodReconciliationDiscrepancies.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      await expect(
        service.getCodReconciliationDiscrepancies({ page: 1, limit: 20 }),
      ).resolves.toEqual({
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('maps the staff breakdown with currencies kept separate', async () => {
      mockRepository.summarizeCodReconciliationByStaff.mockResolvedValueOnce([
        {
          staffId: STAFF_ID,
          staff: collector,
          currency: 'USD',
          collectedAmount: new Prisma.Decimal('100.00'),
          expectedAmount: new Prisma.Decimal('120.00'),
          outstandingAmount: new Prisma.Decimal('20.00'),
          count: 2,
        },
        {
          staffId: OTHER_STAFF_ID,
          staff: courier,
          currency: 'KHR',
          collectedAmount: new Prisma.Decimal('400000.00'),
          expectedAmount: new Prisma.Decimal('400000.00'),
          outstandingAmount: new Prisma.Decimal('0.00'),
          count: 1,
        },
      ]);

      await expect(
        service.getCodReconciliationByStaff({
          page: 1,
          limit: 20,
          period: 'daily',
        }),
      ).resolves.toEqual([
        {
          staffId: STAFF_ID,
          staff: collector,
          currency: 'USD',
          collectedAmount: '100.00',
          expectedAmount: '120.00',
          outstandingAmount: '20.00',
          count: 2,
        },
        {
          staffId: OTHER_STAFF_ID,
          staff: courier,
          currency: 'KHR',
          collectedAmount: '400000.00',
          expectedAmount: '400000.00',
          outstandingAmount: '0.00',
          count: 1,
        },
      ]);
    });

    it('returns an empty staff breakdown', async () => {
      mockRepository.summarizeCodReconciliationByStaff.mockResolvedValueOnce(
        [],
      );

      await expect(
        service.getCodReconciliationByStaff({ page: 1, limit: 20 }),
      ).resolves.toEqual([]);
    });

    it('maps the period breakdown with currencies kept separate', async () => {
      mockRepository.summarizeCodReconciliationByPeriod.mockResolvedValueOnce([
        {
          period: '2026-10-15',
          currency: 'USD',
          collectedAmount: new Prisma.Decimal('100.00'),
          expectedAmount: new Prisma.Decimal('120.00'),
          outstandingAmount: new Prisma.Decimal('20.00'),
          count: 2,
        },
        {
          period: '2026-10',
          currency: 'KHR',
          collectedAmount: new Prisma.Decimal('400000.00'),
          expectedAmount: new Prisma.Decimal('400000.00'),
          outstandingAmount: new Prisma.Decimal('0.00'),
          count: 1,
        },
      ]);

      await expect(
        service.getCodReconciliationByPeriod({
          page: 1,
          limit: 20,
          period: 'monthly',
        }),
      ).resolves.toEqual([
        {
          period: '2026-10-15',
          currency: 'USD',
          collectedAmount: '100.00',
          expectedAmount: '120.00',
          outstandingAmount: '20.00',
          count: 2,
        },
        {
          period: '2026-10',
          currency: 'KHR',
          collectedAmount: '400000.00',
          expectedAmount: '400000.00',
          outstandingAmount: '0.00',
          count: 1,
        },
      ]);
      expect(
        mockRepository.summarizeCodReconciliationByPeriod,
      ).toHaveBeenCalledWith(expect.objectContaining({ period: 'monthly' }));
    });

    it('returns an empty period breakdown', async () => {
      mockRepository.summarizeCodReconciliationByPeriod.mockResolvedValueOnce(
        [],
      );

      await expect(
        service.getCodReconciliationByPeriod({ page: 1, limit: 20 }),
      ).resolves.toEqual([]);
    });

    it('rejects an invalid reconciliation date range before querying', async () => {
      await expect(
        service.getCodReconciliationRecords({
          page: 1,
          limit: 20,
          startDate: '2026-02-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(
        mockRepository.findCodReconciliationRecords,
      ).not.toHaveBeenCalled();
    });

    it.each([
      [
        'getCodReconciliationRecords',
        () => service.getCodReconciliationRecords({ page: 1, limit: 20 }),
        mockRepository.findCodReconciliationRecords,
      ],
      [
        'getCodReconciliationSummary',
        () => service.getCodReconciliationSummary({ page: 1, limit: 20 }),
        mockRepository.summarizeCodReconciliation,
      ],
      [
        'getUncollectedDeliveredCodOrders',
        () => service.getUncollectedDeliveredCodOrders({ page: 1, limit: 20 }),
        mockRepository.findUncollectedDeliveredCodOrders,
      ],
      [
        'getCodReconciliationDiscrepancies',
        () => service.getCodReconciliationDiscrepancies({ page: 1, limit: 20 }),
        mockRepository.findCodReconciliationDiscrepancies,
      ],
      [
        'getCodReconciliationByStaff',
        () => service.getCodReconciliationByStaff({ page: 1, limit: 20 }),
        mockRepository.summarizeCodReconciliationByStaff,
      ],
      [
        'getCodReconciliationByPeriod',
        () => service.getCodReconciliationByPeriod({ page: 1, limit: 20 }),
        mockRepository.summarizeCodReconciliationByPeriod,
      ],
    ])('propagates repository errors from %s', async (_name, invoke, mock) => {
      const repositoryError = new Error('database unavailable');
      mock.mockRejectedValueOnce(repositoryError);

      await expect(invoke()).rejects.toBe(repositoryError);
    });
  });
});
