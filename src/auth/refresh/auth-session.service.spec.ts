import { AccessTokenService } from '../jwt/access-token.service.js';
import { LoginResponseDto, getAuthSessionSecrets } from '../dto/login-response.dto.js';
import { Role } from '../../generated/prisma/enums.js';
import { AuthSessionService } from './auth-session.service.js';
import { RefreshTokenService } from './refresh-token.service.js';

describe('AuthSessionService', () => {
  it('issues an access token and an internal refresh session without changing JSON fields', async () => {
    const user = {
      id: '3f2504e0-4f89-41d3-8a9b-0c1d2e3f4a5b',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      passwordHash: 'hashed-secret',
      phone: null,
      status: 'ACTIVE',
      role: Role.CUSTOMER,
      emailVerifiedAt: null,
      lastLoginAt: null,
      passwordChangedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const accessTokens = {
      sign: vi.fn().mockReturnValue('signed-access-token'),
      expiresIn: '15m',
    } as unknown as AccessTokenService;
    const refreshTokens = {
      createSession: vi.fn().mockResolvedValue({
        rawRefreshToken: 'raw-refresh-token',
        rawCsrfToken: 'raw-csrf-token',
        session: {
          familyId: 'family-id',
          expiresAt: new Date('2026-11-25T19:20:00.000Z'),
        },
      }),
    } as unknown as RefreshTokenService;

    const response = await new AuthSessionService(
      accessTokens,
      refreshTokens,
    ).issue(user);

    expect(response).toBeInstanceOf(LoginResponseDto);
    expect(Object.keys(response).sort()).toEqual(
      ['accessToken', 'expiresIn', 'user'].sort(),
    );
    expect(JSON.stringify(response)).not.toContain('raw-refresh-token');
    expect(getAuthSessionSecrets(response)).toEqual(
      expect.objectContaining({
        rawRefreshToken: 'raw-refresh-token',
        rawCsrfToken: 'raw-csrf-token',
        familyId: 'family-id',
      }),
    );
  });
});
