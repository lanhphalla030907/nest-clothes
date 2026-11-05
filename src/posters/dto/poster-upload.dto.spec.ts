import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePosterDto } from './create-poster.dto.js';
import { UploadPosterImageDto } from './upload-poster-image.dto.js';

/**
 * Multipart poster bodies carry `displayOrder` as a string. These tests run the
 * same global pipe configuration as `main.ts`, so they exercise the exact layer
 * where class-validator previously saw `"0"` instead of `0`.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

type DtoClass = typeof CreatePosterDto | typeof UploadPosterImageDto;

const transformBody = async (
  metatype: DtoClass,
  body: Record<string, unknown>,
): Promise<CreatePosterDto | UploadPosterImageDto> =>
  (await pipe.transform(body, {
    type: 'body',
    metatype,
  })) as CreatePosterDto | UploadPosterImageDto;

const rejectionMessages = async (
  metatype: DtoClass,
  displayOrder: string,
): Promise<string[]> => {
  try {
    await transformBody(metatype, { displayOrder });
  } catch (error) {
    const response = (error as BadRequestException).getResponse() as {
      message: string[];
    };

    return response.message;
  }

  throw new Error(
    `Expected displayOrder ${JSON.stringify(displayOrder)} to be rejected`,
  );
};

describe.each([
  ['CreatePosterDto', CreatePosterDto],
  ['UploadPosterImageDto', UploadPosterImageDto],
] as const)('%s displayOrder', (_name, DtoClass) => {
  it.each(['0', '1', '5'])(
    'coerces the multipart string %j to a number before validation',
    async (value) => {
      const dto = await transformBody(DtoClass, { displayOrder: value });

      expect(dto.displayOrder).toBe(Number(value));
    },
  );

  it.each(['-1', '-5'])('rejects the negative value %j', async (value) => {
    const messages = await rejectionMessages(DtoClass, value);

    expect(messages).toContain('displayOrder must not be less than 0');
  });

  it.each(['1.5', '0.1'])('rejects the decimal value %j', async (value) => {
    const messages = await rejectionMessages(DtoClass, value);

    expect(messages).toContain('displayOrder must be an integer number');
  });

  it('rejects a non-numeric value without silently coercing it to zero', async () => {
    expect(await rejectionMessages(DtoClass, 'not-a-number')).toContain(
      'displayOrder must be an integer number',
    );
    expect(await rejectionMessages(DtoClass, '')).toContain(
      'displayOrder must be an integer number',
    );
  });
});
