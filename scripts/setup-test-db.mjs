import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { assertIsTestDatabase, resolveTestDatabaseUrl } from './test-database.mjs';

/**
 * Creates the isolated integration-test database when it is missing and applies
 * the existing Prisma migrations to it.
 *
 * This never migrates or deletes the development database: the URL is resolved
 * and guarded by `test-database.mjs` first, and `DATABASE_URL` is overridden only
 * for the child `prisma migrate deploy` process.
 */
const testUrl = resolveTestDatabaseUrl();
const url = new URL(testUrl);
const databaseName = assertIsTestDatabase(url);

const adminUrl = new URL(testUrl);
adminUrl.pathname = '/postgres';

const client = new Client({ connectionString: adminUrl.toString() });

try {
  await client.connect();

  const existing = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName],
  );

  if (existing.rowCount === 0) {
    const quoted = `"${databaseName.replace(/"/g, '""')}"`;
    await client.query(`CREATE DATABASE ${quoted}`);
    console.log(`Created test database "${databaseName}"`);
  } else {
    console.log(`Test database "${databaseName}" already exists`);
  }
} finally {
  await client.end();
}

const migration = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: 'inherit',
  shell: true,
});

if (migration.status !== 0) {
  process.exit(migration.status ?? 1);
}

console.log(`Test database ready: "${databaseName}"`);
