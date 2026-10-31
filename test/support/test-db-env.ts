import { resolveTestDatabaseUrl } from '../../scripts/test-database.mjs';

/**
 * Points the application at the isolated integration-test database.
 *
 * Vitest runs setup files before the test module (and therefore before that
 * module's `import 'dotenv/config'`), so this value wins over the development
 * `DATABASE_URL` loaded from `.env`. `resolveTestDatabaseUrl` refuses to return
 * the development database, which is what keeps a destructive fixture cleanup
 * from ever reaching it.
 */
process.env.DATABASE_URL = resolveTestDatabaseUrl();
