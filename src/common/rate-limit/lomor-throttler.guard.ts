import { ExecutionContext, Injectable } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
} from '@nestjs/throttler';

@Injectable()
export class LomorThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);
    this.setResponseHeader(res, 'X-RateLimit-Limit', detail.limit);
    this.setResponseHeader(
      res,
      'X-RateLimit-Remaining',
      Math.max(0, detail.limit - detail.totalHits),
    );
    this.setResponseHeader(res, 'X-RateLimit-Reset', detail.timeToExpire);
    await super.throwThrottlingException(context, detail);
  }
}
