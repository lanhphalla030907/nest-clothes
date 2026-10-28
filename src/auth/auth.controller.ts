import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from './types/authenticated-user.js';

/**
 * The authentication endpoints.
 *
 * `POST /auth/login` is deliberately unauthenticated — it is how a caller obtains a
 * credential in the first place — and it is the only route in this controller that is.
 * Every other route mounts {@link JwtAuthGuard}, so nothing here can be reached by a
 * request whose identity was not proven by a signed token.
 *
 * `GET /auth/me` exists so a client can recover its own identity after a reload
 * without keeping a user id it chose for itself. There is deliberately no route that
 * takes an id: a client asking "who am I" cannot turn the question into "who is user
 * 42", because the only answer available is the caller's own.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Exchanges valid credentials for an access token.
   *
   * `200 OK` rather than `201`: no durable resource is created, and a client that
   * retries a login gets another token rather than an error about a duplicate.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  /**
   * The authenticated caller's own record.
   *
   * `200` with the safe user — never `passwordHash`, and never a user named by the
   * request.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  currentUser(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    return this.authService.currentUser(user.id);
  }
}
