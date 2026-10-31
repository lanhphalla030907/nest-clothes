import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryService } from './delivery.service.js';
import {
  DeliveryRepository,
  type DeliveryTransactionClient,
} from './repositories/delivery.repository.js';
import { DeliveryStatus, Role } from '../generated/prisma/enums.js';
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
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
  delivery_staff_id: string;
  status: DeliveryStatus;
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
  overrides: Partial<AssignmentRow> & Pick<AssignmentRow, 'id' | 'deliveryStaffId'>,
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
  overrides: Partial<RawAssignmentRow> & Pick<RawAssignmentRow, 'id' | 'delivery_staff_id'>,
): RawAssignmentRow {
  return {
    id: overrides.id,
    delivery_staff_id: overrides.delivery_staff_id,
    status: overrides.status ?? DeliveryStatus.ASSIGNED,
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
    findUserById: vi.fn<
      (userId: string, tx?: DeliveryTransactionClient) => Promise<UserRow | null>
    >(),
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
    runInTransaction: vi.fn<
      (
        fn: (tx: DeliveryTransactionClient) => Promise<unknown>,
      ) => Promise<unknown>
    >(),
    findAssignmentById: vi.fn<
      (
        assignmentId: string,
        tx?: DeliveryTransactionClient,
      ) => Promise<AssignmentRow | null>
    >(),
    updateAssignmentStatus: vi.fn<
      (
        assignmentId: string,
        status: DeliveryStatus,
        notes?: string,
        tx?: DeliveryTransactionClient,
      ) => Promise<AssignmentRow>
    >(),
    findAssignmentsForStaff: vi.fn<
      (
        staffId: string,
        filters: { status?: DeliveryStatus; page?: number; limit?: number },
        tx?: DeliveryTransactionClient,
      ) => Promise<PaginatedAssignments>
    >(),
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
          makeUser(role === Role.ADMIN ? ADMIN_ID : MANAGER_ID, role, 'INACTIVE'),
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
          makeUser(role === Role.ADMIN ? ADMIN_ID : MANAGER_ID, role, 'INACTIVE'),
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

      it.each(managerRoles)(
        'allows an active %s to reassign',
        async (role) => {
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

          const { tx } = makeTransaction([
            { id: ORDER_ID, status: 'CONFIRMED' },
          ]);
          mockRepository.runInTransaction.mockImplementationOnce(async (fn) =>
            fn(tx),
          );

          await expect(
            service.reassignDelivery(manager.id, ORDER_ID, dto),
          ).resolves.toEqual(created);
        },
      );

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

        await expect(
          service.getMyAssignments(STAFF_ID, {}),
        ).resolves.toEqual({
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

          await expect(
            service.getMyAssignments('actor', {}),
          ).rejects.toThrow(ForbiddenException);
          expect(
            mockRepository.findAssignmentsForStaff,
          ).not.toHaveBeenCalled();
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
        expect(
          mockRepository.updateAssignmentStatus,
        ).not.toHaveBeenCalled();
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
  });
});
