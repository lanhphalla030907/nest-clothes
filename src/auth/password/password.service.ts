import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

/**
 * Argon2id parameters following the OWASP Password Storage Cheat Sheet
 * minimum configuration: 19 MiB of memory, 2 iterations, 1 degree of
 * parallelism.
 */
const ARGON2ID_OPTIONS = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  /**
   * Hashes a plaintext password with Argon2id.
   * The returned digest is the only representation of the password that may
   * ever be persisted or stored.
   */
  async hash(password: string): Promise<string> {
    return hash(password, ARGON2ID_OPTIONS);
  }

  /**
   * Verifies a plaintext password against an existing Argon2id digest using a
   * constant-time comparison performed by the native library.
   */
  async verify(digest: string, password: string): Promise<boolean> {
    return verify(digest, password);
  }
}