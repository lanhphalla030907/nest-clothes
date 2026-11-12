import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Cross-field equality check, used for `confirmPassword`.
 *
 * A custom constraint rather than a service-side check so a mismatch is a
 * normal 400 validation error at the request boundary, exactly like every
 * other malformed input.
 */
export function Match(property: string, options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'match',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [relatedProperty] = args.constraints as [string];
          const related = (args.object as Record<string, unknown>)[
            relatedProperty
          ];

          return typeof value === 'string' && value === related;
        },
        defaultMessage(args: ValidationArguments): string {
          const [relatedProperty] = args.constraints as [string];
          return `${args.property} must match ${relatedProperty}`;
        },
      },
    });
  };
}
