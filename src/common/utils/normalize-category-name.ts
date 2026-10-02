/**
 * @deprecated Category-facing alias for the shared `normalizeName`.
 *
 * The implementation moved to `./normalize-name.js` so the products feature
 * reuses it instead of duplicating the rule. Existing imports are unchanged.
 */
export { normalizeName as normalizeCategoryName } from './normalize-name.js';