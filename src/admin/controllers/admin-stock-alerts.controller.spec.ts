import { GUARDS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { AdminStockAlertsController } from './admin-stock-alerts.controller.js';

describe('AdminStockAlertsController', () => {
  let service: { findStockAlerts: ReturnType<typeof vi.fn> };
  let controller: AdminStockAlertsController;

  beforeEach(() => {
    service = { findStockAlerts: vi.fn() };
    controller = new AdminStockAlertsController(service as never);
  });

  it('passes the query through to the service', async () => {
    service.findStockAlerts.mockResolvedValue({ summary: {}, items: [], pagination: {} });

    await controller.findStockAlerts({ page: 1, limit: 10 });

    expect(service.findStockAlerts).toHaveBeenCalledWith({ page: 1, limit: 10 });
  });

  it('passes an explicit filter through', async () => {
    service.findStockAlerts.mockResolvedValue({ summary: {}, items: [], pagination: {} });

    await controller.findStockAlerts({ page: 1, limit: 10, status: 'all' });

    expect(service.findStockAlerts).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      status: 'all',
    });
  });

  it('passes the in stock filter through', async () => {
    service.findStockAlerts.mockResolvedValue({ summary: {}, items: [], pagination: {} });

    await controller.findStockAlerts({ page: 1, limit: 10, status: 'in' });

    expect(service.findStockAlerts).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      status: 'in',
    });
  });

  it('is restricted to administrators', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminStockAlertsController),
    ).toEqual([Role.ADMIN]);

    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminStockAlertsController,
    ) as unknown[];

    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RolesGuard);
  });
});
