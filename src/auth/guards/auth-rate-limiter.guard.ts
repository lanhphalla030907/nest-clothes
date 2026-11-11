import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

@Injectable()
export class AuthRateLimiterGuard implements CanActivate {
  private readonly hits = new Map<string, RateLimitRecord>();
  private readonly maxAttempts: number = 20;
  private readonly windowMs: number = 60_000; // 1 minute

  constructor() {
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

    const now = Date.now();
    const record = this.hits.get(key);

    if (!record || record.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (record.count >= this.maxAttempts) {
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
