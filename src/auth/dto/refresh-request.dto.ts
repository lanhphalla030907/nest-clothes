import { IsString, Matches } from 'class-validator';

/**
 * Body of POST /auth/refresh.
 *
 * The operation key is a 32-byte random value encoded as Base64URL (43
 * characters). The service performs the strict canonical re-encoding check;
 * this DTO only rejects shapes that cannot possibly be such a value.
 */
export class RefreshRequestDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, {
    message: 'operationKey must be 32 random bytes encoded as Base64URL',
  })
  operationKey: string;
}
