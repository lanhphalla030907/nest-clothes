import type { User } from '../../generated/prisma/client.js';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';

/**
 * The response of a successful login.
 *
 * Exactly two things: a bearer token and the safe user it identifies.
 *
 * Deliberately **not** here, and worth stating because each has been a leak in
 * applications like this one:
 *
 * - `passwordHash` — the user half goes through {@link UserResponseDto}, which does not
 *   carry the digest and copies fields one by one rather than spreading the entity.
 * - the signing secret, or any JWT setting — this object is built from the identity and
 *   the token alone, so there is no path by which configuration reaches a client.
 * - a refresh token, which this phase does not have. When one is added it belongs here
 *   and nowhere else, so that "what a login returns" stays a single reviewable list.
 */
export class LoginResponseDto {
  accessToken: string;

  /**
   * The access token's lifetime, so a client can schedule re-authentication instead of
   * guessing. A duration string, never a secret.
   */
  expiresIn: string;

  user: UserResponseDto;

  /**
   * Builds the response from the entity `AuthService` already holds.
   *
   * `UserResponseDto.fromEntity` is the only path the user takes into a response, which
   * is what makes "no password hash" a property of the type rather than a rule someone
   * has to remember each time.
   */
  static fromIdentity(
    user: User,
    accessToken: string,
    expiresIn: string,
  ): LoginResponseDto {
    const dto = new LoginResponseDto();

    dto.accessToken = accessToken;
    dto.expiresIn = expiresIn;
    dto.user = UserResponseDto.fromEntity(user);
    return dto;
  }
}
