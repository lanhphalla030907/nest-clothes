import { Global, Module } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { readCloudinaryCredentials } from './cloudinary.config.js';
import { CloudinaryService } from './cloudinary.service.js';
import {
  CLOUDINARY_CLIENT,
  CLOUDINARY_CREDENTIALS,
  type CloudinaryClient,
  type CloudinaryCredentials,
} from './cloudinary.types.js';

/**
 * Reads and validates the credentials, then hands the SDK its configuration.
 *
 * Runs once at module construction, i.e. during application bootstrap, so a
 * missing or blank variable fails the process before it serves a request. That is
 * the whole point of validating here rather than on first upload: an operator
 * finds out at deploy time, not from a user's failed request.
 *
 * The returned credentials are frozen, so no consumer can mutate the validated
 * values out from under the redaction in `CloudinaryService`.
 */
const cloudinaryCredentialsProvider = {
  provide: CLOUDINARY_CREDENTIALS,
  useFactory: (): CloudinaryCredentials => readCloudinaryCredentials(),
};

/**
 * Configures the Cloudinary SDK and exposes it as an injectable client.
 *
 * `secure: true` forces HTTPS delivery URLs so a returned `secure_url` can never
 * be plain `http://`; `secure_distribution` is left unset so Cloudinary uses the
 * account's own default CDN host.
 *
 * The SDK's module-level configuration is global state, which is exactly why
 * `CloudinaryService` depends on the injected client rather than importing the
 * singleton itself — a test never touches this factory, so no test can leave the
 * process configured with fake credentials.
 *
 * `resource_type` is deliberately *not* defaulted here. The client is shared, so a
 * default would be one more setting a caller could forget; it is pinned on every
 * individual call in `CloudinaryService` instead.
 */
const cloudinaryClientProvider = {
  provide: CLOUDINARY_CLIENT,
  useFactory: (
    credentials: CloudinaryCredentials,
  ): CloudinaryClient => {
    cloudinary.config({
      cloud_name: credentials.cloudName,
      api_key: credentials.apiKey,
      api_secret: credentials.apiSecret,
      secure: true,
    });

    return cloudinary as unknown as CloudinaryClient;
  },
  inject: [CLOUDINARY_CREDENTIALS],
};

/**
 * Owns the Cloudinary capability: credentials, the configured SDK client, and the
 * upload/delete service.
 *
 * @Global because the credentials are a process-wide deployment fact and every
 * future consumer (the upload endpoint in Phase 4C, and anything that cleans up an
 * orphaned asset) needs the same one without each module re-importing this edge.
 * Only `CloudinaryService` is exported — the client and the credentials stay
 * internal, so no other module can read the API secret or bypass the service's
 * validation by calling the SDK directly.
 *
 * Deliberately a leaf module: it imports nothing and nothing imports it except
 * `AppModule`, so it cannot introduce a cycle with any domain module.
 */
@Global()
@Module({
  providers: [
    cloudinaryCredentialsProvider,
    cloudinaryClientProvider,
    CloudinaryService,
  ],
  exports: [CloudinaryService],
})
export class CloudinaryModule {}
