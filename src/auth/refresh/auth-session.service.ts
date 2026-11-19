import { Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client.js';
import {
  attachAuthSessionSecrets,
  LoginResponseDto,
} from '../dto/login-response.dto.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import { RefreshTokenService } from './refresh-token.service.js';

@Injectable()
export class AuthSessionService {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async issue(user: User): Promise<LoginResponseDto> {
    const response = LoginResponseDto.fromIdentity(
      user,
      this.accessTokens.sign(user),
      this.accessTokens.expiresIn,
    );
    const issued = await this.refreshTokens.createSession(user.id);

    return attachAuthSessionSecrets(response, {
      rawRefreshToken: issued.rawRefreshToken,
      rawCsrfToken: issued.rawCsrfToken,
      familyId: issued.session.familyId,
      expiresAt: issued.session.expiresAt,
    });
  }
}
