import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  AUTH_RATE_LIMIT_METADATA,
  type AuthRateLimitOptions,
} from './auth-rate-limit.decorator.js';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const DEFAULT_LIMIT: AuthRateLimitOptions = {
  limit: 20,
  windowMs: 60_000,
};

@Injectable()
export class AuthRateLimiterGuard implements CanActivate {
  private readonly hits = new Map<string, RateLimitRecord>();

  constructor(private readonly reflector: Reflector) {
    // Periodic garbage collection every 5 minutes to prevent memory leaks
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.hits.entries()) {
        if (record.resetAt <= now) {
          this.hits.delete(key);
        }
      }
    }, 300_000);
    timer.unref?.();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const clientIp = this.getClientIp(request);
    const key = `auth:${request.path}:${clientIp}`;
    const { limit, windowMs } =
      this.reflector.getAllAndOverride<AuthRateLimitOptions>(
        AUTH_RATE_LIMIT_METADATA,
        [context.getHandler(), context.getClass()],
      ) ?? DEFAULT_LIMIT;

    const now = Date.now();
    const record = this.hits.get(key);

    if (!record || record.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (record.count >= limit) {
      throw new HttpException(
        'Too many attempts just now. Give it a moment, then try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count += 1;
    return true;
  }

  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return request.ip || request.socket.remoteAddress || 'unknown-client';
  }
}
