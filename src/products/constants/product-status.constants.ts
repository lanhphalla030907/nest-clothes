/**
 * The product lifecycle, as stored in `products.status`.
 *
 * `products.status` is a free-form column rather than a Prisma enum or a lookup
 * table, mirroring `users.status`: the values are an application-level concept,
 * they never need to be queried relationally, and adding one must not require a
 * migration. The values are centralised here so no service repeats the literals.
 *
 * `status` and `is_active` are deliberately independent:
 * - `status` is where the product is in its lifecycle.
 * - `is_active` is whether the record is enabled at all.
 *
 * A product is therefore `ACTIVE` but `is_active = false` when a catalog team
 * temporarily switches it off without retiring it.
 */
export const PRODUCT_STATUS = {
  /** Being prepared. Not presentable in the storefront. */
  DRAFT: 'DRAFT',
  /** Presentable and sellable. */
  ACTIVE: 'ACTIVE',
  /** No longer sold. Retained for history rather than deleted. */
  ARCHIVED: 'ARCHIVED',
} as const;

export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

/**
 * Lifecycle a product starts in when it is created.
 *
 * New products are never published implicitly: a product becomes `ACTIVE`
 * through an explicit, authorised lifecycle action that does not exist yet.
 */
export const DEFAULT_PRODUCT_STATUS: ProductStatus = PRODUCT_STATUS.DRAFT;

/** New products are enabled; `isActive` is about the record, not the sale. */
export const DEFAULT_PRODUCT_IS_ACTIVE = true;