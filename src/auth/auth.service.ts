import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { normalizeEmail } from '../common/utils/normalize-email.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { LoginDto } from './dto/login.dto.js';
import { PasswordService } from './password/password.service.js';

/**
 * Deliberately identical for an unknown email, a wrong password and a
 * non-active account so that the endpoint never discloses which of the three
 * occurred.
 */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

/**
 * Non-secret value hashed once and reused when the requested email does not
 * exist. Verifying against it keeps the response time of "unknown email" close
 * to that of "wrong password", which prevents account enumeration through
 * timing. It is never associated with a user.
 */
const TIMING_EQUALISATION_SECRET =
  'auth-timing-equalisation-placeholder-secret';

@Injectable()
export class AuthService {
  private timingEqualisationDigest: Promise<string> | undefined;

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordService: PasswordService,
  ) {}

  /**
   * Authenticates an existing user and returns its safe representation.
   *
   * `lastLoginAt` is written only once the credentials are proven valid and the
   * account is active. Unexpected repository failures are intentionally allowed
   * to propagate instead of being reported as an authentication failure.
   */
  async login(dto: LoginDto): Promise<UserResponseDto> {
    const email = normalizeEmail(dto.email);

    const user = await this.usersRepository.findByEmail(email);

    if (!user) {
      await this.equaliseTimingAgainstUnknownEmail(dto.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const passwordMatches = await this.passwordService.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    if (user.status !== ACTIVE_USER_STATUS) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const authenticatedUser = await this.usersRepository.updateLastLoginAt(
      user.id,
      new Date(),
    );

    return UserResponseDto.fromEntity(authenticatedUser);
  }

  private async equaliseTimingAgainstUnknownEmail(password: string): Promise<void> {
    this.timingEqualisationDigest ??=
      this.passwordService.hash(TIMING_EQUALISATION_SECRET);

    const digest = await this.timingEqualisationDigest;

    await this.passwordService.verify(digest, password);
  }
}
