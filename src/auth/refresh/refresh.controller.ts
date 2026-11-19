import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { parseCorsOrigins } from '../../common/http-security.config.js';
import { RefreshRequestDto } from '../dto/refresh-request.dto.js';
import { RefreshResponseDto } from '../dto/refresh-response.dto.js';
import {
  clearRefreshCookies,
  setRefreshCookies,
} from './refresh-cookies.js';
import {
  REFRESH_CSRF_COOKIE,
  REFRESH_SESSION_COOKIE,
} from './refresh-token.constants.js';
import {
  RefreshTokenService,
  type RotatedRefreshSession,
} from './refresh-token.service.js';

/** The CSRF cookie is readable by the client, which echoes it in this header. */
const CSRF_HEADER = 'x-csrf-token';

/**
 * Only classifications where the session family is known to be invalid may
 * clear cookies. A stale replay deliberately leaves the valid replacement
 * session and its cookies untouched.
 */
const CLEAR_COOKIE_CODES = new Set([
  'REFRESH_TOKEN_REUSE',
  'REFRESH_OPERATION_BINDING_MISMATCH',
  'INVALID_REFRESH_SESSION',
]);

function readCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(cookies, name)) {
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

/** Constant-time double-submit comparison; length is checked first. */
function csrfMatches(cookie: string, header: string): boolean {
  const left = Buffer.from(cookie, 'utf8');
  const right = Buffer.from(header, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * POST /auth/refresh — the HTTP face of the existing rotation service.
 *
 * The refresh token never leaves the HttpOnly cookie and never enters the JSON
 * response; this controller only forwards the already-validated values to the
 * service and translates its outcome into cookies and status codes.
 */
@Controller('auth')
export class RefreshController {
  constructor(private readonly refreshTokens: RefreshTokenService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() dto: RefreshRequestDto,
  ): Promise<RefreshResponseDto> {
    this.assertAllowedOrigin(request);

    const cookies = readCookies(request.headers.cookie);
    const refreshToken = cookies[REFRESH_SESSION_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const csrfCookie = cookies[REFRESH_CSRF_COOKIE];
    const csrfHeader = request.headers[CSRF_HEADER];
    if (
      !csrfCookie ||
      typeof csrfHeader !== 'string' ||
      !csrfMatches(csrfCookie, csrfHeader)
    ) {
      // Checked before rotate(): a CSRF failure must not revoke a valid family.
      throw new ForbiddenException('Invalid CSRF token');
    }

    // Bind the double-submitted value to the session this refresh token names.
    if (!(await this.refreshTokens.csrfBindingMatches(refreshToken, csrfCookie))) {
      throw new ForbiddenException('Invalid CSRF token');
    }

    // Reuses the service's strict 32-byte Base64URL validation without calling
    // rotation, so a malformed key is a client error rather than an auth failure.
    try {
      this.refreshTokens.hashOperationKey(dto.operationKey);
    } catch {
      throw new BadRequestException('Invalid operation key');
    }

    return this.rotate(refreshToken, dto.operationKey, response);
  }

  /**
   * POST /auth/logout — best-effort revocation of the cookie's session family.
   *
   * Only a valid, unexpired token with matching CSRF is revoked. Every other
   * token state clears the cookies and answers 204, so a stale cookie never
   * distinguishes invalid, expired or revoked sessions to the caller.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    this.assertAllowedOrigin(request);

    const cookies = readCookies(request.headers.cookie);
    const refreshToken = cookies[REFRESH_SESSION_COOKIE];
    if (!refreshToken) {
      clearRefreshCookies(response);
      return;
    }

    const familyId = await this.refreshTokens.findActiveFamilyId(refreshToken);
    if (familyId === null) {
      clearRefreshCookies(response);
      return;
    }

    const csrfCookie = cookies[REFRESH_CSRF_COOKIE];
    const csrfHeader = request.headers[CSRF_HEADER];
    if (
      !csrfCookie ||
      typeof csrfHeader !== 'string' ||
      !csrfMatches(csrfCookie, csrfHeader)
    ) {
      // CSRF is checked before any revocation; a valid family is left intact.
      throw new ForbiddenException('Invalid CSRF token');
    }

    if (!(await this.refreshTokens.csrfBindingMatches(refreshToken, csrfCookie))) {
      throw new ForbiddenException('Invalid CSRF token');
    }

    await this.refreshTokens.revokeFamily(familyId, 'logout');
    clearRefreshCookies(response);
  }

  private async rotate(
    refreshToken: string,
    operationKey: string,
    response: Response,
  ): Promise<RefreshResponseDto> {
    let rotated: RotatedRefreshSession;
    try {
      rotated = await this.refreshTokens.rotate(refreshToken, operationKey);
    } catch (error) {
      const code = this.failureCode(error);
      if (CLEAR_COOKIE_CODES.has(code)) clearRefreshCookies(response);
      throw error;
    }

    setRefreshCookies(
      response,
      rotated.rawRefreshToken,
      rotated.rawCsrfToken,
      rotated.session.expiresAt,
    );

    const body = new RefreshResponseDto();
    body.accessToken = rotated.accessToken;
    body.expiresIn = rotated.expiresIn;
    return body;
  }

  /** Reuses the configured CORS origin list rather than defining a new policy. */
  private assertAllowedOrigin(request: Request): void {
    const allowed = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
    const candidates: string[] = [];

    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) candidates.push(origin);

    const referer = request.headers.referer;
    if (typeof referer === 'string' && referer.length > 0) {
      try {
        candidates.push(new URL(referer).origin);
      } catch {
        throw new ForbiddenException('Forbidden origin');
      }
    }

    if (candidates.length === 0 || candidates.some((item) => !allowed.includes(item))) {
      throw new ForbiddenException('Forbidden origin');
    }
  }

  private failureCode(error: unknown): string {
    if (error instanceof UnauthorizedException) {
      const payload = error.getResponse();
      if (typeof payload === 'object' && payload !== null && 'code' in payload) {
        return String((payload as { code: unknown }).code);
      }
      return 'INVALID_REFRESH_SESSION';
    }
    return '';
  }
}
