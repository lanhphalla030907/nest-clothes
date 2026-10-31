export function resolveTestDatabaseUrl(
  env?: Record<string, string | undefined>,
): string;

export function assertIsTestDatabase(
  testUrl: URL,
  env?: Record<string, string | undefined>,
): string;
