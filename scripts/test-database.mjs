import 'dotenv/config';

/**
 * Resolves the PostgreSQL URL used by the Delivery integration suite.
 *
 * `TEST_DATABASE_URL` wins when it is set. Otherwise the development database
 * name is suffixed with `_test` (`clothing_ecommerce` -> `clothing_ecommerce_test`)
 * on the same server, so the suite never touches the database the application
 * uses during development.
 *
 * The guard below is deliberately strict: a test run deletes the fixtures it
 * creates, and pointing that at a real database is not a mistake worth making
 * possible.
 */
export function resolveTestDatabaseUrl(env = process.env) {
  const base = env.DATABASE_URL;

  if (!base) {
    throw new Error(
      'DATABASE_URL is not set — the Delivery integration tests need a real PostgreSQL instance',
    );
  }

  const baseUrl = new URL(base);
  const testUrl = new URL(env.TEST_DATABASE_URL ?? base);

  if (!env.TEST_DATABASE_URL) {
    testUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}_test`;
  }

  assertIsTestDatabase(testUrl, env);

  return testUrl.toString();
}

/**
 * Refuses a URL that names the development database, or whose database name
 * does not look like a test database.
 */
export function assertIsTestDatabase(testUrl, env = process.env) {
  const name = testUrl.pathname.replace(/^\//, '');

  if (name.length === 0) {
    throw new Error('Refusing to run integration tests without a database name');
  }

  if (env.DATABASE_URL) {
    const base = new URL(env.DATABASE_URL);
    const sameServer =
      base.hostname === testUrl.hostname && base.port === testUrl.port;
    const sameDatabase = base.pathname.replace(/^\//, '') === name;

    if (sameServer && sameDatabase) {
      throw new Error(
        `Refusing to use "${name}" for integration tests: it is the development database`,
      );
    }
  }

  if (!/(^|[_-])test($|[_-])/i.test(name)) {
    throw new Error(
      `Refusing to use "${name}" for integration tests: the database name must contain "test"`,
    );
  }

  return name;
}
