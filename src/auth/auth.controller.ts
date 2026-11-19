import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { GoogleLoginDto } from './dto/google-login.dto.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { Throttle } from '@nestjs/throttler';
import { RATE_LIMIT_POLICIES } from '../common/rate-limit/rate-limit.config.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { AuthSessionCookieInterceptor } from './refresh/auth-session-cookie.interceptor.js';
import {
  PasswordResetMessage,
  PasswordResetService,
} from './password-reset/password-reset.service.js';
import type { AuthenticatedUser } from './types/authenticated-user.js';

/**
 * The authentication endpoints.
 *
 * `POST /auth/login` and `POST /auth/google` are deliberately unauthenticated — they are how a caller obtains
 * an access token. They are rate-limited to prevent brute-force attacks.
 *
 * Protected routes mount {@link JwtAuthGuard}, so nothing there can be reached by an unauthenticated request.
 */
@Controller('auth')
@UseInterceptors(AuthSessionCookieInterceptor)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  /**
   * Exchanges valid email/password credentials for an access token.
   */
  @Post('login')
  @Throttle({
    default: {
      limit: RATE_LIMIT_POLICIES.login.limit,
      ttl: RATE_LIMIT_POLICIES.login.ttl,
    },
  })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  /**
   * Authenticates or registers a customer via Google ID Token.
   */
  @Post('google')
  @Throttle({
    default: {
      limit: RATE_LIMIT_POLICIES.googleLogin.limit,
      ttl: RATE_LIMIT_POLICIES.googleLogin.ttl,
    },
  })
  @HttpCode(HttpStatus.OK)
  googleLogin(@Body() dto: GoogleLoginDto): Promise<LoginResponseDto> {
    return this.authService.googleLogin(dto);
  }

  /**
   * Starts a password reset. The response never says whether the address exists.
   */
  @Post('forgot-password')
  @Throttle({
    default: {
      limit: RATE_LIMIT_POLICIES.forgotPassword.limit,
      ttl: RATE_LIMIT_POLICIES.forgotPassword.ttl,
    },
  })
  @HttpCode(HttpStatus.OK)
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<PasswordResetMessage> {
    return this.passwordResetService.requestReset(dto);
  }

  /**
   * Consumes a single-use reset token and sets a new local password.
   */
  @Post('reset-password')
  @Throttle({
    default: {
      limit: RATE_LIMIT_POLICIES.resetPassword.limit,
      ttl: RATE_LIMIT_POLICIES.resetPassword.ttl,
    },
  })
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<PasswordResetMessage> {
    return this.passwordResetService.resetPassword(dto);
  }

  /**
   * Explicitly connects a Google identity to the caller's authenticated account.
   */
  @Post('google/link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  linkGoogle(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GoogleLoginDto,
  ): Promise<{ success: boolean; provider: string }> {
    return this.authService.linkGoogle(user.id, dto);
  }

  /**
   * Returns linked external providers (e.g. ['google']) for the authenticated caller.
   */
  @Get('identities')
  @UseGuards(JwtAuthGuard)
  getLinkedIdentities(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Array<{ id: string; provider: string; createdAt: Date }>> {
    return this.authService.getLinkedIdentities(user.id);
  }

  /**
   * The authenticated caller's own record.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  currentUser(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    return this.authService.currentUser(user.id);
  }
}
