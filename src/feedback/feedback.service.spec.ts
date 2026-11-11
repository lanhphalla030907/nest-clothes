import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../generated/prisma/enums.js';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { FeedbackService } from './feedback.service.js';
import { FeedbackRepository } from './feedback.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { FEEDBACK_STATUS_UNPUBLISHED } from './constants/feedback-status.constants.js';
import { FeedbackResponseDto } from './dto/feedback-response.dto.js';

const CUSTOMER_ID = 'a1b2c3d4-e5f6-4a1b-8c9d-0e1f2a3b4c5d';
const OTHER_CUSTOMER_ID = 'b2c3d4e5-f6a7-4b2c-9d0e-1f2a3b4c5d6e';
const ADMIN_ID = 'c3d4e5f6-a7b8-4c3d-a0e1-2f3a4b5c6d7e';
const FEEDBACK_ID = 'd4e5f6a7-b8c9-4d5e-9f0a-1b2c3d4e5f6a';

const aFeedback = (overrides: Record<string, unknown> = {}) => ({
  id: FEEDBACK_ID,
  customerId: CUSTOMER_ID,
  title: 'Packaging was lovely',
  message: 'The recyclable wrapping is a nice touch.',
  status: 'UNPUBLISHED',
  createdAt: new Date('2026-01-10T09:00:00.000Z'),
  updatedAt: new Date('2026-01-10T09:00:00.000Z'),
  ...overrides,
});

const aCustomer = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOMER_ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  role: Role.CUSTOMER,
  status: ACTIVE_USER_STATUS,
  ...overrides,
});

function makeRepository() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByIdAndCustomer: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
    delete: vi.fn(),
  };
}

function makeUsersRepository() {
  return {
    findById: vi.fn(),
  };
}

describe('FeedbackService customer ownership', () => {
  it('derives customerId from the session, never the body', async () => {
    const repository = makeRepository();
    repository.create.mockResolvedValue(aFeedback());

    const service = new FeedbackService(repository as any, {} as any);

    await service.createForCustomer(CUSTOMER_ID, {
      title: 'Packaging was lovely',
      message: 'The recyclable wrapping is a nice touch.',
    });

    expect(repository.create).toHaveBeenCalledWith({
      customer: { connect: { id: CUSTOMER_ID } },
      title: 'Packaging was lovely',
      message: 'The recyclable wrapping is a nice touch.',
      status: FEEDBACK_STATUS_UNPUBLISHED,
    });
  });

  it('returns one of the customer\'s own rows', async () => {
    const repository = makeRepository();
    repository.findByIdAndCustomer.mockResolvedValue(aFeedback());

    const service = new FeedbackService(repository as any, {} as any);

    const result = await service.findCustomerById(FEEDBACK_ID, CUSTOMER_ID);

    expect(result).toBeInstanceOf(FeedbackResponseDto);
    expect(repository.findByIdAndCustomer).toHaveBeenCalledWith(FEEDBACK_ID, CUSTOMER_ID);
  });

  it('404s when another customer names the row', async () => {
    const repository = makeRepository();
    repository.findByIdAndCustomer.mockResolvedValue(null);

    const service = new FeedbackService(repository as any, {} as any);

    await expect(
      service.findCustomerById(FEEDBACK_ID, OTHER_CUSTOMER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates only an owned row', async () => {
    const repository = makeRepository();
    repository.findByIdAndCustomer.mockResolvedValue(aFeedback());
    repository.update.mockResolvedValue(aFeedback({ title: 'Packaging was gorgeous' }));

    const service = new FeedbackService(repository as any, {} as any);

    await service.updateForCustomer(FEEDBACK_ID, CUSTOMER_ID, {
      title: 'Packaging was gorgeous',
    });

    expect(repository.update).toHaveBeenCalledWith(FEEDBACK_ID, {
      title: 'Packaging was gorgeous',
    });
  });

  it('404s when another customer updates the row', async () => {
    const repository = makeRepository();
    repository.findByIdAndCustomer.mockResolvedValue(null);

    const service = new FeedbackService(repository as any, {} as any);

    await expect(
      service.updateForCustomer(FEEDBACK_ID, OTHER_CUSTOMER_ID, {
        title: 'Hacked',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('deletes only an owned row', async () => {
    const repository = makeRepository();
    repository.findByIdAndCustomer.mockResolvedValue(aFeedback());
    repository.delete.mockResolvedValue(undefined);

    const service = new FeedbackService(repository as any, {} as any);

    await service.deleteForCustomer(FEEDBACK_ID, CUSTOMER_ID);

    expect(repository.delete).toHaveBeenCalledWith(FEEDBACK_ID);
  });

  it('404s when another customer deletes the row', async () => {
    const repository = makeRepository();
    repository.findByIdAndCustomer.mockResolvedValue(null);

    const service = new FeedbackService(repository as any, {} as any);

    await expect(
      service.deleteForCustomer(FEEDBACK_ID, OTHER_CUSTOMER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.delete).not.toHaveBeenCalled();
  });
});

describe('FeedbackService administration', () => {
  it('creates feedback for an existing customer account', async () => {
    const repository = makeRepository();
    repository.create.mockResolvedValue(aFeedback());
    const usersRepository = makeUsersRepository();
    usersRepository.findById.mockResolvedValue(aCustomer());

    const service = new FeedbackService(repository as any, usersRepository as any);

    const result = await service.createForAdmin({
      customerId: CUSTOMER_ID,
      title: 'Lovely shop',
      message: 'Great service.',
    });

    expect(result).toBeInstanceOf(FeedbackResponseDto);
    expect(repository.create).toHaveBeenCalledWith({
      customer: { connect: { id: CUSTOMER_ID } },
      title: 'Lovely shop',
      message: 'Great service.',
      status: FEEDBACK_STATUS_UNPUBLISHED,
    });
  });

  it('404s when the selected account does not exist', async () => {
    const repository = makeRepository();
    const usersRepository = makeUsersRepository();
    usersRepository.findById.mockResolvedValue(null);

    const service = new FeedbackService(repository as any, usersRepository as any);

    await expect(
      service.createForAdmin({
        customerId: '00000000-0000-0000-0000-000000000000',
        title: 'Lovely shop',
        message: 'Great service.',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a non-customer account', async () => {
    const repository = makeRepository();
    const usersRepository = makeUsersRepository();
    usersRepository.findById.mockResolvedValue(aCustomer({ role: Role.ADMIN }));

    const service = new FeedbackService(repository as any, usersRepository as any);

    await expect(
      service.createForAdmin({
        customerId: ADMIN_ID,
        title: 'Lovely shop',
        message: 'Great service.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('publishes and unpublishes a row', async () => {
    const repository = makeRepository();
    repository.findById.mockResolvedValue(aFeedback());
    repository.setStatus.mockResolvedValue(aFeedback({ status: 'PUBLISHED' }));

    const service = new FeedbackService(repository as any, {} as any);

    const result = await service.setStatus(FEEDBACK_ID, { status: 'PUBLISHED' });

    expect(result.status).toBe('PUBLISHED');
    expect(repository.setStatus).toHaveBeenCalledWith(FEEDBACK_ID, 'PUBLISHED');
  });

  it('404s on publish for a missing row', async () => {
    const repository = makeRepository();
    repository.findById.mockResolvedValue(null);

    const service = new FeedbackService(repository as any, {} as any);

    await expect(
      service.setStatus(FEEDBACK_ID, { status: 'PUBLISHED' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.setStatus).not.toHaveBeenCalled();
  });
});
