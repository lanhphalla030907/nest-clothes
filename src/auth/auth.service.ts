import crypto from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { normalizeEmail } from '../common/utils/normalize-email.js';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { UserIdentityRepository } from '../users/repositories/user-identity.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { GoogleLoginDto } from './dto/google-login.dto.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleAuthService } from './google/google-auth.service.js';
import { AccessTokenService } from './jwt/access-token.service.js';
import { PasswordService } from './password/password.service.js';

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';
const TIMING_EQUALISATION_SECRET = 'auth-timing-equalisation-placeholder-secret';
const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class AuthService {
  private timingEqualisationDigest: Promise<string> | undefined;

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly userIdentityRepository: UserIdentityRepository,
    private readonly passwordService: PasswordService,
    private readonly accessTokenService: AccessTokenService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Authenticates an existing user and returns a token plus its safe representation.
   *
   * `lastLoginAt` is written only once the credentials are proven valid and the
   * account is active. Unexpected repository failures are intentionally allowed to
   * propagate instead of being reported as an authentication failure.
   *
   * The token is signed **after** the successful write, from the same row the response
   * describes, so the claims and the returned user cannot disagree. Signing before the
   * write would hand out a token for an account whose login was never recorded.
   */
  async login(dto: LoginDto): Promise<LoginResponseDto> {
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

    return LoginResponseDto.fromIdentity(
      authenticatedUser,
      this.accessTokenService.sign(authenticatedUser),
      this.accessTokenService.expiresIn,
    );
  }

  /**
   * Authenticates or registers a customer using a verified Google ID Token.
   *
   * Handles:
   * A. Returning Google customer: finds account by (provider='google', sub).
   * B. New Google customer: creates account with Role.CUSTOMER, active status,
   *    verified email timestamp, and an unguessable password hash.
   * C. Existing account with matching email:
   *    - If verified: links Google identity in transaction and signs in.
   *    - If unverified: rejects with ConflictException requiring password login first.
   * D. Concurrency: handles P2002 duplicate identity or email races safely.
   * E. Status checks: enforces ACTIVE_USER_STATUS; disabled accounts cannot sign in.
   */
  async googleLogin(dto: GoogleLoginDto): Promise<LoginResponseDto> {
    const payload = await this.googleAuthService.verifyToken(
      dto.idToken,
      dto.nonce,
    );

    // 1. Returning Google Customer
    const existingIdentity =
      await this.userIdentityRepository.findByProviderSubject(
        'google',
        payload.sub,
      );

    if (existingIdentity) {
      if (existingIdentity.user.status !== ACTIVE_USER_STATUS) {
        throw new UnauthorizedException(
          'Your account is inactive or suspended.',
        );
      }

      const authenticatedUser = await this.usersRepository.updateLastLoginAt(
        existingIdentity.user.id,
        new Date(),
      );

      return LoginResponseDto.fromIdentity(
        authenticatedUser,
        this.accessTokenService.sign(authenticatedUser),
        this.accessTokenService.expiresIn,
      );
    }

    // 2. Account Resolution by Verified Email
    const email = normalizeEmail(payload.email);
    const existingUser = await this.usersRepository.findByEmail(email);

    if (existingUser) {
      if (existingUser.status !== ACTIVE_USER_STATUS) {
        throw new UnauthorizedException(
          'Your account is inactive or suspended.',
        );
      }

      // If email is unverified on the existing password account, require manual linking
      // Generic message to avoid leaking unverified account existence
      if (existingUser.emailVerifiedAt === null) {
        throw new ConflictException(
          'Unable to complete Google sign-in. Please sign in with your password to link your account.',
        );
      }

      // Existing verified account: securely link Google identity
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.userIdentityRepository.create(
            {
              userId: existingUser.id,
              provider: 'google',
              providerSubject: payload.sub,
            },
            tx,
          );

          await this.usersRepository.updateLastLoginAt(
            existingUser.id,
            new Date(),
            tx,
          );
        });
      } catch (error) {
        if (this.isUniqueConstraintViolation(error)) {
          // Concurrent race: identity was inserted right now by a parallel request
          const racedIdentity =
            await this.userIdentityRepository.findByProviderSubject(
              'google',
              payload.sub,
            );
          if (racedIdentity) {
            // Security requirement: Never transfer an existing Google identity to another user
            if (racedIdentity.userId !== existingUser.id) {
              throw new ConflictException(
                'This Google account is already linked to another account.',
              );
            }
            if (racedIdentity.user.status !== ACTIVE_USER_STATUS) {
              throw new UnauthorizedException(
                'Your account is inactive or suspended.',
              );
            }
            const authUser = await this.usersRepository.updateLastLoginAt(
              racedIdentity.user.id,
              new Date(),
            );
            return LoginResponseDto.fromIdentity(
              authUser,
              this.accessTokenService.sign(authUser),
              this.accessTokenService.expiresIn,
            );
          }
        }
        throw error;
      }

      const authenticatedUser = await this.usersRepository.findById(
        existingUser.id,
      );
      return LoginResponseDto.fromIdentity(
        authenticatedUser!,
        this.accessTokenService.sign(authenticatedUser!),
        this.accessTokenService.expiresIn,
      );
    }

    // 3. New Customer Registration
    const randomPasswordSecret = crypto.randomBytes(32).toString('hex');
    const passwordHash = await this.passwordService.hash(randomPasswordSecret);
    const firstName = (payload.firstName || 'Customer').trim();
    const lastName = (payload.lastName || 'User').trim();

    try {
      const createdUser = await this.prisma.$transaction(async (tx) => {
        const user = await this.usersRepository.create(
          {
            firstName: firstName.length > 0 ? firstName : 'Customer',
            lastName: lastName.length > 0 ? lastName : 'User',
            email,
            passwordHash,
            status: ACTIVE_USER_STATUS,
            role: Role.CUSTOMER, // Strictly CUSTOMER
            emailVerifiedAt: new Date(),
            lastLoginAt: new Date(),
          },
          tx,
        );

        await this.userIdentityRepository.create(
          {
            userId: user.id,
            provider: 'google',
            providerSubject: payload.sub,
          },
          tx,
        );

        return user;
      });

      return LoginResponseDto.fromIdentity(
        createdUser,
        this.accessTokenService.sign(createdUser),
        this.accessTokenService.expiresIn,
      );
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        // Concurrent registration race: check if identity or user exists now
        const racedIdentity =
          await this.userIdentityRepository.findByProviderSubject(
            'google',
            payload.sub,
          );
        if (racedIdentity) {
          if (racedIdentity.user.status !== ACTIVE_USER_STATUS) {
            throw new UnauthorizedException(
              'Your account is inactive or suspended.',
            );
          }
          const authUser = await this.usersRepository.updateLastLoginAt(
            racedIdentity.user.id,
            new Date(),
          );
          return LoginResponseDto.fromIdentity(
            authUser,
            this.accessTokenService.sign(authUser),
            this.accessTokenService.expiresIn,
          );
        }

        // Email uniqueness conflict during concurrent registration
        const racedUser = await this.usersRepository.findByEmail(email);
        if (racedUser) {
          if (racedUser.status !== ACTIVE_USER_STATUS) {
            throw new UnauthorizedException(
              'Your account is inactive or suspended.',
            );
          }
          if (racedUser.emailVerifiedAt === null) {
            throw new ConflictException(
              'Unable to complete Google sign-in. Please sign in with your password to link your account.',
            );
          }
        }

        throw new ConflictException(
          'A conflict occurred during account creation. Please try again.',
        );
      }
      throw error;
    }
  }

  /**
   * Explicitly connects a Google identity to an already-authenticated user account.
   *
   * Session security: The caller must present an active, verified access token (`JwtAuthGuard`).
   * The short 15-minute token lifespan guarantees recent authentication.
   *
   * Rejects if:
   * - Google identity is already connected to another user (never transfer identities).
   * - Caller account is inactive.
   */
  async linkGoogle(
    userId: string,
    dto: GoogleLoginDto,
  ): Promise<{ success: boolean; provider: string }> {
    const payload = await this.googleAuthService.verifyToken(
      dto.idToken,
      dto.nonce,
    );

    const existingIdentity =
      await this.userIdentityRepository.findByProviderSubject(
        'google',
        payload.sub,
      );

    if (existingIdentity) {
      if (existingIdentity.userId === userId) {
        return { success: true, provider: 'google' };
      }
      throw new ConflictException(
        'This Google account is already linked to another account.',
      );
    }

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User does not exist');
    }

    if (user.status !== ACTIVE_USER_STATUS) {
      throw new UnauthorizedException(
        'Your account is inactive or suspended.',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.userIdentityRepository.create(
          {
            userId,
            provider: 'google',
            providerSubject: payload.sub,
          },
          tx,
        );

        // If the user's email was unverified and matches this verified Google email, mark it verified
        if (
          user.emailVerifiedAt === null &&
          normalizeEmail(payload.email) === normalizeEmail(user.email)
        ) {
          await this.usersRepository.updateEmailVerifiedAt(
            userId,
            new Date(),
            tx,
          );
        }
      });

      return { success: true, provider: 'google' };
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        throw new ConflictException(
          'This Google account is already linked to another account.',
        );
      }
      throw error;
    }
  }

  /**
   * Returns safe provider information for linked identities of the authenticated user.
   */
  async getLinkedIdentities(
    userId: string,
  ): Promise<Array<{ id: string; provider: string; createdAt: Date }>> {
    return this.userIdentityRepository.findIdentitiesByUserId(userId);
  }

  /**
   * The safe representation of the caller, as the database currently has it.
   */
  async currentUser(userId: string): Promise<UserResponseDto> {
    const user = await this.usersRepository.findById(userId);

    if (!user) {
      throw new NotFoundException('User does not exist');
    }

    return UserResponseDto.fromEntity(user);
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    );
  }

  private async equaliseTimingAgainstUnknownEmail(
    password: string,
  ): Promise<void> {
    this.timingEqualisationDigest ??=
      this.passwordService.hash(TIMING_EQUALISATION_SECRET);

    const digest = await this.timingEqualisationDigest;

    await this.passwordService.verify(digest, password);
  }
}
