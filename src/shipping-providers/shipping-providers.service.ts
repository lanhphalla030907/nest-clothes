import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type ShippingProvider } from '../generated/prisma/client.js';
import { normalizeMoney } from '../common/utils/normalize-money.js';
import { normalizeShippingProviderCode } from '../common/utils/normalize-shipping-provider-code.js';
import { CreateShippingProviderDto } from './dto/create-shipping-provider.dto.js';
import { ShippingProviderResponseDto } from './dto/shipping-provider-response.dto.js';
import { UpdateShippingProviderDto } from './dto/update-shipping-provider.dto.js';
import {
  ShippingProvidersRepository,
  type CreateShippingProviderData,
  type UpdateShippingProviderData,
} from './repositories/shipping-providers.repository.js';

const DUPLICATE_CODE_MESSAGE =
  'A shipping provider with this code already exists';
const MAX_BASE_FEE = '9999999999.99';
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;

@Injectable()
export class ShippingProvidersService {
  constructor(
    private readonly shippingProvidersRepository: ShippingProvidersRepository,
  ) {}

  async listActive(): Promise<ShippingProvider[]> {
    return this.shippingProvidersRepository.findActive();
  }

  async listForAdmin(): Promise<ShippingProviderResponseDto[]> {
    const providers = await this.shippingProvidersRepository.findAll();
    return providers.map(ShippingProviderResponseDto.fromEntity);
  }

  async create(
    dto: CreateShippingProviderDto,
  ): Promise<ShippingProviderResponseDto> {
    const code = normalizeShippingProviderCode(dto.code);
    await this.assertCodeAvailable(code);

    const data: CreateShippingProviderData = {
      code,
      name: dto.name.trim(),
      description: this.normalizeDescription(dto.description),
      baseFee: this.normalizeBaseFee(dto.baseFee),
      isActive: dto.isActive ?? true,
      supportsCod: dto.supportsCod ?? false,
    };

    try {
      const provider = await this.shippingProvidersRepository.create(data);
      return ShippingProviderResponseDto.fromEntity(provider);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateShippingProviderDto,
  ): Promise<ShippingProviderResponseDto> {
    await this.requireProvider(id);
    const data = this.buildUpdateData(dto);

    if (data.code !== undefined) {
      await this.assertCodeAvailable(data.code, id);
    }

    try {
      const provider = await this.shippingProvidersRepository.update(id, data);
      return ShippingProviderResponseDto.fromEntity(provider);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  private buildUpdateData(
    dto: UpdateShippingProviderDto,
  ): UpdateShippingProviderData {
    const data: UpdateShippingProviderData = {};

    if (dto.code !== undefined) {
      data.code = normalizeShippingProviderCode(dto.code);
    }
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      data.description = this.normalizeDescription(dto.description);
    }
    if (dto.baseFee !== undefined) {
      data.baseFee = this.normalizeBaseFee(dto.baseFee);
    }
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }
    if (dto.supportsCod !== undefined) {
      data.supportsCod = dto.supportsCod;
    }

    return data;
  }

  private normalizeDescription(description?: string | null): string | null {
    if (description === undefined || description === null) return null;
    const trimmed = description.trim();
    return trimmed === '' ? null : trimmed;
  }

  private normalizeBaseFee(value: unknown): string {
    const normalized = normalizeMoney(value);
    if (typeof normalized !== 'string' || !MONEY_PATTERN.test(normalized)) {
      throw new BadRequestException(
        'baseFee must be a non-negative amount with at most 2 decimal places and at most 10 integer digits',
      );
    }

    const amount = new Prisma.Decimal(normalized);
    if (amount.gt(MAX_BASE_FEE)) {
      throw new BadRequestException(
        'baseFee must be a non-negative amount with at most 2 decimal places and at most 10 integer digits',
      );
    }
    return amount.toFixed(2);
  }

  private async requireProvider(id: string): Promise<ShippingProvider> {
    const provider = await this.shippingProvidersRepository.findById(id);
    if (provider === null) {
      throw new NotFoundException(`Shipping provider ${id} does not exist`);
    }
    return provider;
  }

  private async assertCodeAvailable(
    code: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.shippingProvidersRepository.findByCode(code);
    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(DUPLICATE_CODE_MESSAGE);
    }
  }

  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      this.isProviderCodeUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_CODE_MESSAGE);
    }
    throw error;
  }

  private isProviderCodeUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const target = error.meta?.['target'];
    if (Array.isArray(target)) return target.includes('code');
    if (typeof target === 'string') return target.includes('code');

    return error.meta?.['modelName'] === 'ShippingProvider';
  }
}
