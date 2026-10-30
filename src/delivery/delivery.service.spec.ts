import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryService } from './delivery.service';
import { DeliveryRepository } from './repositories/delivery.repository';
import { Role } from '../generated/prisma/enums';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';

describe('DeliveryService', () => {
  let service: DeliveryService;
  let repository: any;

  const mockRepository = {
    findUserById: vi.fn(),
    findOrderById: vi.fn(),
    findActiveAssignment: vi.fn(),
    createAssignment: vi.fn(),
    runInTransaction: vi.fn(),
    findAssignmentById: vi.fn(),
    updateAssignmentStatus: vi.fn(),
    findAssignmentsForStaff: vi.fn(),
    findAllDeliveryOrders: vi.fn(),
    endAssignment: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryService,
        { provide: DeliveryRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<DeliveryService>(DeliveryService);
    repository = module.get(DeliveryRepository);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('assignDelivery', () => {
    const assignedById = 'manager-123';
    const dto = { orderId: 'order-123', deliveryStaffId: 'staff-123' };

    it('should throw ForbiddenException if assigner is not a delivery manager', async () => {
      mockRepository.findUserById.mockResolvedValueOnce({
        id: assignedById,
        role: Role.CUSTOMER,
        status: 'ACTIVE',
      } as any);

      await expect(service.assignDelivery(assignedById, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw BadRequestException if staff is inactive', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'INACTIVE' } as any);

      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: dto.orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: { findFirst: vi.fn() },
        };
        return fn(tx as any);
      });

      await expect(service.assignDelivery(assignedById, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if staff has wrong role', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.CUSTOMER, status: 'ACTIVE' } as any);

      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: dto.orderId, status: 'CONFIRMED' }]),
        };
        return fn(tx as any);
      });

      await expect(service.assignDelivery(assignedById, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if order status invalid', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);

      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: dto.orderId, status: 'PENDING' }]),
        };
        return fn(tx as any);
      });

      await expect(service.assignDelivery(assignedById, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should successfully assign order', async () => {
      mockRepository.findUserById.mockReset();
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' })
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' });

      const mockAssignment = { id: 'assign-1', orderId: dto.orderId, status: 'ASSIGNED' };
      mockRepository.createAssignment.mockReset();
      mockRepository.createAssignment.mockResolvedValue(mockAssignment);

      mockRepository.runInTransaction.mockReset();
      mockRepository.runInTransaction.mockImplementation((callback) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: dto.orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
        };
        return Promise.resolve(callback(tx));
      });

      const result = await service.assignDelivery(assignedById, dto);
      expect(result).toEqual(mockAssignment);
    });
  });

  describe('reassignDelivery', () => {
    const assignedById = 'manager-123';
    const orderId = 'order-123';
    const dto = { deliveryStaffId: 'staff-456' };

    it('should reject reassignment after OUT_FOR_DELIVERY', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);

      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValueOnce([{ id: orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: {
            findFirst: vi.fn().mockResolvedValueOnce({ id: 'assign-1', status: 'OUT_FOR_DELIVERY' }),
          },
        };
        return fn(tx);
      });

      await expect(service.reassignDelivery(assignedById, orderId, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepository.createAssignment).not.toHaveBeenCalled();
    });

    it('should reject reassignment after DELIVERED', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);

      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: {
            findFirst: vi.fn().mockResolvedValue({ id: 'assign-1', status: 'DELIVERED' }),
          },
        };
        return fn(tx as any);
      });

      await expect(service.reassignDelivery(assignedById, orderId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject reassignment after RETURNED', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);

      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: {
            findFirst: vi.fn().mockResolvedValue({ id: 'assign-1', status: 'RETURNED' }),
          },
        };
        return fn(tx as any);
      });

      await expect(service.reassignDelivery(assignedById, orderId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow reassignment from FAILED_DELIVERY and preserve history', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);

      const mockAssignment = { id: 'assign-2', orderId, status: 'ASSIGNED' };
      mockRepository.createAssignment.mockResolvedValueOnce(mockAssignment as any);

      const updateMock = vi.fn().mockResolvedValueOnce({});
      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValueOnce([{ id: orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: {
            findFirst: vi.fn().mockResolvedValueOnce({ id: 'assign-1', status: 'FAILED_DELIVERY', endedAt: null }),
            update: updateMock,
          },
        };
        const result = await fn(tx);
        return result;
      });

      const result = await service.reassignDelivery(assignedById, orderId, dto);
      expect(result).toEqual(mockAssignment);
      expect(updateMock).toHaveBeenCalled();
    });

    it('should preserve history on reassignment', async () => {
      mockRepository.findUserById
        .mockResolvedValueOnce({ id: assignedById, role: Role.DELIVERY_MANAGER, status: 'ACTIVE' } as any)
        .mockResolvedValueOnce({ id: dto.deliveryStaffId, role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);

      const mockAssignment = { id: 'assign-2', orderId, status: 'ASSIGNED' };
      mockRepository.createAssignment.mockResolvedValueOnce(mockAssignment as any);

      const updateMock = vi.fn().mockResolvedValueOnce({});
      mockRepository.runInTransaction.mockImplementationOnce(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValueOnce([{ id: orderId, status: 'CONFIRMED' }]),
          deliveryAssignment: {
            findFirst: vi.fn().mockResolvedValueOnce({ id: 'assign-1', status: 'ASSIGNED', endedAt: null }),
            update: updateMock,
          },
        };
        return fn(tx);
      });

      await service.reassignDelivery(assignedById, orderId, dto);
      expect(updateMock).toHaveBeenCalled();
    });
  });

  describe('getMyAssignment - IDOR protection', () => {
    it('should prevent staff from accessing another staff assignment', async () => {
      mockRepository.findUserById.mockResolvedValue({ id: 'staff-1', role: Role.DELIVERY_STAFF, status: 'ACTIVE' } as any);
      mockRepository.findAssignmentById.mockResolvedValue({
        id: 'assign-1',
        deliveryStaffId: 'staff-2',
      } as any);

      await expect(service.getMyAssignment('staff-1', 'assign-1')).rejects.toThrow(ForbiddenException);
    });
  });
});
