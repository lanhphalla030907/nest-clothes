import type { INestApplication } from '@nestjs/common';

const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

export function parseCorsOrigins(
  value: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): readonly string[] {
  // A wildcard can never be an allowed origin for credentialed requests.
  const configured = value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .filter((origin) => origin !== '*');

  if (configured && configured.length > 0) {
    return [...new Set(configured)];
  }

  return nodeEnv === 'production' ? [] : [...LOCAL_DEV_ORIGINS];
}

export function applyCors(app: INestApplication): void {
  const allowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);

  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'x-csrf-token'],
    credentials: true,
  });
}

export function applySecurityHeaders(app: INestApplication): void {
  app.use((_request: unknown, response: {
    setHeader(name: string, value: string): void;
  }, next: () => void) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

    if (process.env.NODE_ENV === 'production') {
      response.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }

    next();
  });
}
