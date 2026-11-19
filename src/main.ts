import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { parseTrustedProxySetting } from './common/rate-limit/rate-limit.config.js';
import { applyCors, applySecurityHeaders } from './common/http-security.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  applyCors(app);
  applySecurityHeaders(app);
  app.getHttpAdapter().getInstance().set(
    'trust proxy',
    parseTrustedProxySetting(process.env.TRUSTED_PROXIES),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true, 
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();