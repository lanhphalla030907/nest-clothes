import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CodArea } from '../generated/prisma/client.js';
import { CreateCodAreaDto } from './dto/create-cod-area.dto.js';
import { CodAreaResponseDto } from './dto/cod-area-response.dto.js';
import { PublicCodAreaResponseDto } from './dto/public-cod-area-response.dto.js';
import { UpdateCodAreaDto } from './dto/update-cod-area.dto.js';
import {
  CodAreasRepository,
  type CreateCodAreaData,
  type UpdateCodAreaData,
} from './repositories/cod-areas.repository.js';

const DUPLICATE_CODE_MESSAGE = 'A COD area with this code already exists';

@Injectable()
export class CodAreasService {
  constructor(private readonly codAreasRepository: CodAreasRepository) {}

  async listForAdmin(): Promise<CodAreaResponseDto[]> {
    const areas = await this.codAreasRepository.findAll();
    return areas.map(CodAreaResponseDto.fromEntity);
  }

  async listCodEnabled(): Promise<PublicCodAreaResponseDto[]> {
    const areas = await this.codAreasRepository.findCodEnabled();
    return areas.map(PublicCodAreaResponseDto.fromEntity);
  }

  async create(dto: CreateCodAreaDto): Promise<CodAreaResponseDto> {
    const code = dto.code.trim().toUpperCase();
    await this.assertCodeAvailable(code);

    const data: CreateCodAreaData = {
      code,
      name: dto.name.trim(),
      codEnabled: dto.codEnabled ?? false,
    };

    try {
      const area = await this.codAreasRepository.create(data);
      return CodAreaResponseDto.fromEntity(area);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async update(id: string, dto: UpdateCodAreaDto): Promise<CodAreaResponseDto> {
    await this.requireArea(id);
    const data: UpdateCodAreaData = {};

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.codEnabled !== undefined) data.codEnabled = dto.codEnabled;

    try {
      const area = await this.codAreasRepository.update(id, data);
      return CodAreaResponseDto.fromEntity(area);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  private async requireArea(id: string): Promise<CodArea> {
    const area = await this.codAreasRepository.findById(id);
    if (area === null) {
      throw new NotFoundException(`COD area ${id} does not exist`);
    }
    return area;
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.codAreasRepository.findByCode(code);
    if (existing !== null) {
      throw new ConflictException(DUPLICATE_CODE_MESSAGE);
    }
  }

  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      this.isCodeUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_CODE_MESSAGE);
    }
    throw error;
  }

  private isCodeUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const target = error.meta?.['target'];
    if (Array.isArray(target)) {
      return target.includes('code') || target.includes('cod_areas_code_key');
    }
    if (typeof target === 'string') {
      return target.includes('code');
    }
    return error.meta?.['modelName'] === 'CodArea';
  }
}
