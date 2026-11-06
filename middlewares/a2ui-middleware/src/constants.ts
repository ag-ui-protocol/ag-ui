/**
 * Canonical id of the published A2UI basic catalog. Mirrors the `$id` and
 * `catalogId` declared by the catalog document itself, so a surface built with
 * this id resolves against the catalog a renderer registers under its own id.
 *
 * Deliberately not re-exported from the package entry. `@ag-ui/a2ui-toolkit`
 * owns this value; the middleware only keeps a copy because the toolkit's
 * `BASIC_CATALOG_ID` still holds the superseded id until
 * ag-ui-protocol/ag-ui#2696 lands. Publishing a second copy would leave two
 * constants in two packages that have to stay byte-identical with nothing
 * enforcing it, which is how the ids drifted apart in the first place. Once
 * #2696 is in, this file goes and `index.ts` imports from the toolkit, which
 * the middleware already depends on.
 */
export const BASIC_CATALOG_ID =
  "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
