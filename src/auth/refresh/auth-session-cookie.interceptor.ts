import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { tap, type Observable } from 'rxjs';
import {
  getAuthSessionSecrets,
  LoginResponseDto,
} from '../dto/login-response.dto.js';
import { setRefreshCookies } from './refresh-cookies.js';

/**
 * Translates the secrets AuthSessionService attaches to a successful login
 * into the initial HttpOnly refresh cookie and readable CSRF cookie.
 *
 * Sitting in an interceptor keeps every existing login method unchanged: the
 * service still issues exactly one session, and a thrown login error never
 * reaches the success path, so a failed login cannot set partial cookies.
 */
@Injectable()
export class AuthSessionCookieInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap((value: unknown) => {
        if (!(value instanceof LoginResponseDto)) return;
        const secrets = getAuthSessionSecrets(value);
        if (!secrets) return;

        setRefreshCookies(
          context.switchToHttp().getResponse<Response>(),
          secrets.rawRefreshToken,
          secrets.rawCsrfToken,
          secrets.expiresAt,
        );
      }),
    );
  }
}
