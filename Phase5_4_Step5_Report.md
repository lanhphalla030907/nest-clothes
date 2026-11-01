# Phase 5.4 — Step 5 Report

## Scope

Step 5 only: integration testing of the six approved administrative COD financial
reconciliation endpoints against PostgreSQL. No production code, approved
financial logic, DTOs, frontend code, or Step 6 work was changed.

## Files changed

- `test/admin-cod-reconciliation.integration.test.ts` — new dedicated integration
  suite (46 tests).
- `vitest.config.delivery-integration.ts` — includes the new suite in the existing
  isolated PostgreSQL integration configuration.

## Integration architecture

The suite reuses the project’s existing integration infrastructure:

- boots the real `AppModule` through `@nestjs/testing`;
- uses the real `AdminCodReconciliationController`, `DeliveryService`, and
  `DeliveryRepository`; the repository is not mocked;
- runs against the isolated `clothing_ecommerce_test` database selected by
  `test/support/test-db-env.ts` and `scripts/setup-test-db.mjs`;
- installs the same global `ValidationPipe` configuration as the application;
- issues real access tokens with `tokenIssuerFor()` so `JwtAuthGuard` and
  `RolesGuard` execute normally;
- creates fixtures through Prisma and reads all results through actual HTTP
  requests;
- namespaces every fixture with a per-run token and removes all created rows in
  `afterAll`;
- keeps `fileParallelism: false`, matching the existing delivery integration
  suites.

## Endpoints tested

1. `GET /admin/cod-reconciliation`
2. `GET /admin/cod-reconciliation/summary`
3. `GET /admin/cod-reconciliation/uncollected`
4. `GET /admin/cod-reconciliation/discrepancies`
5. `GET /admin/cod-reconciliation/by-staff`
6. `GET /admin/cod-reconciliation/by-period`

## PostgreSQL scenarios covered

- Delivered COD order with exact collection.
- Delivered COD order with partial collection.
- Delivered COD order with no collection.
- Amount mismatch.
- Currency mismatch: USD order with a KHR collection.
- Multiple delivery assignments for one order.
- Reassignment where the latest delivered assignment owns expected/outstanding
  attribution while the original courier owns the collection.
- Multiple currencies in one cohort.
- Multiple daily, weekly, and monthly delivery periods.
- Staff who only deliver.
- Staff who only collect.
- Staff who both deliver and collect.
- Delivered COD order with `delivered_at IS NULL`.
- Orders with no `Payment` row.

## Financial integrity assertions

- No duplicate order counting: a seven-order cohort with one reassigned order
  still returns seven records and one row per order.
- No cross-currency arithmetic: USD and KHR totals remain separate in summary
  and breakdown responses.
- Monetary values remain fixed two-decimal strings; cent-level values are
  asserted exactly (`400.50`, `260.30`, `140.20`, etc.).
- Missing `Payment` rows do not appear as discrepancies and do not make an exact
  collection discrepant.
- Currency mismatches are explicitly classified as `currency-mismatch`.
- Undated delivered orders are excluded by date-filtered records, uncollected,
  summary, and period queries, while remaining visible in unfiltered listings.
- Collection attribution uses `collectedById`.
- Expected and outstanding attribution uses the latest qualifying delivered
  assignment.
- Summary, listing, and discrepancy cohorts use the same order-number namespace
  and therefore the same qualifying orders.

## API and security assertions

- All six endpoints return `200` for an administrator.
- All six endpoints return `401` without a token.
- All six endpoints return `403` for a customer.
- A token signed with a forged `ADMIN` role claim for a database-backed customer
  still returns `403` on all six endpoints.
- Pagination, currency filtering, order filtering, staff filtering, and date
  filtering are exercised through HTTP.
- Invalid `page`, `limit`, dates, UUIDs, currency, status, period, unknown query
  parameters, and inverted date ranges return `400`.
- Responses are asserted for their DTO shape and JSON date serialization.

## Verification results

| Check | Result |
| --- | --- |
| Dedicated reconciliation integration suite | 46 passed |
| Existing delivery integration config (3 files) | 132 passed |
| Full backend unit suite | 77 files, 1861 tests passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |

## Remaining limitations

- PostgreSQL permits one `CodCollection` row per order, so “multiple collections
  for the same order” cannot be created as a valid fixture. Multi-staff
  attribution is instead covered across orders and through reassignment.
- The approved query DTO still normalises invalid `sortBy` / `sortOrder` values
  to `undefined`, so those two parameters fall back to repository defaults
  rather than returning `400`. This step did not change that approved contract.
- Step 5 tests the six canonical routes only; the static route aliases added in
  Step 4 are not re-tested here.
- Fixtures are created directly with Prisma for deterministic dates and amounts;
  all reconciliation reads and authorisation checks still run through the real
  HTTP application and repository.

No verified defect blocked integration, and no Step 6 work was started.
