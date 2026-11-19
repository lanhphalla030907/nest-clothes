/**
 * The only JSON returned by a successful refresh.
 *
 * The replacement refresh token and its CSRF token are delivered exclusively
 * as cookies by the controller; they are deliberately absent from this type so
 * they cannot be serialised into a response body by accident.
 */
export class RefreshResponseDto {
  accessToken: string;

  expiresIn: string;
}
