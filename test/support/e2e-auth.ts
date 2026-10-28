import type { INestApplication } from '@nestjs/common';
import { AccessTokenService } from '../../src/auth/jwt/access-token.service.js';
import { Role } from '../../src/generated/prisma/enums.js';

/**
 * Signs access tokens for integration suites.
 *
 * These suites boot the real feature modules, so `JwtAuthGuard` runs for real and needs a
 * genuine token. It is taken from the container rather than built here — that is the
 * application’s own `AccessTokenService`, configured from the environment — so a test
 * token is verifiable for exactly the reasons a client’s would be, and a change to the
 * signing configuration breaks these tests instead of quietly invalidating them.
 *
 * The `email` claim is a placeholder: the guard re-reads the user from the database, so
 * the claim is never the authority on who this is. That is also what lets a fixture
 * created straight through Prisma — with no password, as these suites do — be presented
 * as a caller.
 */
export type IssueToken = (id: string, role?: Role) => string;

/** A token issuer for `app`, ready to use once the application has been created. */
export function tokenIssuerFor(app: INestApplication): IssueToken {
  const accessTokens = app.get(AccessTokenService);

  return (id, role = Role.CUSTOMER) =>
    accessTokens.sign({ id, email: `${id}@example.test`, role });
}

/**
 * The headers a suite sends when acting as `id`.
 *
 * `id` stays the only argument so a test can read as "…as this user", while what is
 * actually sent is a credential the server has to verify.
 */
export function bearerHeaders(
  issueToken: IssueToken,
  contentType = true,
): (id: string) => Record<string, string> {
  return (id: string) => ({
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${issueToken(id)}`,
  });
}