import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { normalizeEmail } from '../../common/utils/normalize-email.js';

export interface GoogleUserPayload {
  sub: string;
  email: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  picture?: string;
}

const VALID_GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

@Injectable()
export class GoogleAuthService {
  private readonly client: OAuth2Client;
  private readonly clientId: string | undefined;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.clientId =
      this.configService?.get<string>('GOOGLE_CLIENT_ID') ||
      process.env['GOOGLE_CLIENT_ID'];

    this.client = new OAuth2Client(this.clientId);
  }

  /**
   * Verifies Google ID Token cryptographically using Google's official library.
   *
   * Validates:
   * 1. Cryptographic signature against Google's public JWKS keys.
   * 2. Audience matches the configured Google Client ID.
   * 3. Issuer is an authentic Google identity provider endpoint.
   * 4. Token expiration.
   * 5. Email verification flag (`email_verified === true`).
   * 6. Optional nonce protection.
   *
   * Note: The ID token is NEVER logged to preserve credential privacy.
   */
  async verifyToken(
    idToken: string,
    expectedNonce?: string,
  ): Promise<GoogleUserPayload> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthorizedException('Google ID token is required');
    }

    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });

      const payload = ticket.getPayload();

      if (!payload) {
        throw new UnauthorizedException('Invalid Google token payload');
      }

      // 1. Verify issuer
      if (!payload.iss || !VALID_GOOGLE_ISSUERS.includes(payload.iss)) {
        throw new UnauthorizedException('Invalid Google token issuer');
      }

      // 2. Defensive check for expiration
      const nowInSeconds = Math.floor(Date.now() / 1000);
      if (!payload.exp || payload.exp < nowInSeconds) {
        throw new UnauthorizedException('Google token has expired');
      }

      // 3. Verify nonce if expected
      if (expectedNonce && payload.nonce !== expectedNonce) {
        throw new UnauthorizedException('Invalid Google token nonce');
      }

      // 4. Verify email verification status
      if (payload.email_verified !== true) {
        throw new UnauthorizedException('Google email is not verified');
      }

      if (!payload.email || !payload.sub) {
        throw new UnauthorizedException('Google token missing required claims');
      }

      return {
        sub: payload.sub,
        email: normalizeEmail(payload.email),
        emailVerified: payload.email_verified,
        firstName: payload.given_name,
        lastName: payload.family_name,
        picture: payload.picture,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      // Do NOT log the token or sensitive verification internals
      throw new UnauthorizedException('Invalid or unverified Google token');
    }
  }
}
