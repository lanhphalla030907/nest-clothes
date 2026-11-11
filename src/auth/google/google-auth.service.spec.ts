import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAuthService } from './google-auth.service.js';

vi.mock('google-auth-library');

describe('GoogleAuthService', () => {
  let service: GoogleAuthService;
  let mockVerifyIdToken: ReturnType<typeof vi.fn>;
  const clientId = 'test-client-id.apps.googleusercontent.com';

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyIdToken = vi.fn();

    vi.mocked(OAuth2Client).mockImplementation(function (this: any) {
      this.verifyIdToken = mockVerifyIdToken;
      return this;
    } as any);

    const configService = {
      get: vi.fn((key: string) => (key === 'GOOGLE_CLIENT_ID' ? clientId : undefined)),
    } as unknown as ConfigService;

    service = new GoogleAuthService(configService);
  });

  it('rejects an empty or invalid token', async () => {
    await expect(service.verifyToken('')).rejects.toThrow(UnauthorizedException);
    await expect(service.verifyToken(null as unknown as string)).rejects.toThrow(UnauthorizedException);
  });

  it('verifies a valid Google ID token successfully', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: true,
        iss: 'https://accounts.google.com',
        exp: now + 3600,
        given_name: 'Jane',
        family_name: 'Doe',
        picture: 'https://lh3.googleusercontent.com/photo.jpg',
      }),
    });

    const result = await service.verifyToken('valid.jwt.token');

    expect(result).toEqual({
      sub: 'google-sub-12345',
      email: 'user@gmail.com',
      emailVerified: true,
      firstName: 'Jane',
      lastName: 'Doe',
      picture: 'https://lh3.googleusercontent.com/photo.jpg',
    });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'valid.jwt.token',
      audience: clientId,
    });
  });

  it('verifies with issuer accounts.google.com without protocol', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: true,
        iss: 'accounts.google.com',
        exp: now + 3600,
      }),
    });

    const result = await service.verifyToken('valid.jwt.token');
    expect(result.sub).toBe('google-sub-12345');
  });

  it('rejects a token with invalid issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: true,
        iss: 'https://malicious-issuer.com',
        exp: now + 3600,
      }),
    });

    await expect(service.verifyToken('token')).rejects.toThrow('Invalid Google token issuer');
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: true,
        iss: 'https://accounts.google.com',
        exp: now - 100, // in the past
      }),
    });

    await expect(service.verifyToken('expired.token')).rejects.toThrow('Google token has expired');
  });

  it('rejects an unverified email', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: false,
        iss: 'https://accounts.google.com',
        exp: now + 3600,
      }),
    });

    await expect(service.verifyToken('token')).rejects.toThrow('Google email is not verified');
  });

  it('rejects when nonce does not match expected nonce', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: true,
        iss: 'https://accounts.google.com',
        exp: now + 3600,
        nonce: 'actual-nonce',
      }),
    });

    await expect(service.verifyToken('token', 'expected-nonce')).rejects.toThrow(
      'Invalid Google token nonce',
    );
  });

  it('succeeds when nonce matches expected nonce', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: 'user@gmail.com',
        email_verified: true,
        iss: 'https://accounts.google.com',
        exp: now + 3600,
        nonce: 'expected-nonce',
      }),
    });

    const result = await service.verifyToken('token', 'expected-nonce');
    expect(result.sub).toBe('google-sub-12345');
  });

  it('normalizes verified email address to lowercase and trimmed format', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-12345',
        email: '  Jane.Doe@GMAIL.COM  ',
        email_verified: true,
        iss: 'https://accounts.google.com',
        exp: now + 3600,
      }),
    });

    const result = await service.verifyToken('valid.jwt.token');
    expect(result.email).toBe('jane.doe@gmail.com');
  });

  it('rejects when token is missing required sub or email claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email_verified: true,
        iss: 'https://accounts.google.com',
        exp: now + 3600,
      }),
    });

    await expect(service.verifyToken('missing-claims.token')).rejects.toThrow(
      'Google token missing required claims',
    );
  });

  it('handles verification library throwing an error without leaking details', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Signature verification failed'));

    await expect(service.verifyToken('tampered.token')).rejects.toThrow(
      'Invalid or unverified Google token',
    );
  });
});
