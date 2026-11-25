# Versions, testing, compatibility and rollback

The six quality requirements of the study (section 6), and how this repository meets each.

## 1. Versioning

Semantic Versioning per package. `CHANGELOG.md` in every package says what changed and whether a product must do anything. The public
surface is what `src/index.ts` exports — nothing else is promised. A released version is immutable: `scripts/release.mjs` refuses to
overwrite one.

## 2. Automated testing

- Unit and property-style tests for the sensitive logic (signatures, sealing, retries, breaker, job runner, mapping).
- Contract tests per connector against recorded and documented message shapes (`verifiedAgainst: 'docs'` until a sandbox run moves it to
  `'sandbox'`).
- **Consumer matrix** (`scripts/consumer-matrix.mjs`): before a release candidate is taken by any product, each product's integration
  tests run against it. A red product blocks the release for that product.

## 3. Backward compatibility

Within a major version: additions only. Deprecation: a warning in the changelog for at least one minor version and 6 months. Stored
formats carry a version (`vcs1`, `vc1`, job kinds) and both the previous and the next library version read them.

## 4. Rollback

Each product pins exact `.tgz` files from `vendor/v-coder/`. Rolling back = put the previous files back and release the product as usual
(the products' own release scripts health-check and roll back). The library never migrates data; schema changes live in the products'
migrations, expand-then-contract. A connector can be switched off per product without a release (its kill switch in the product's
settings).

## 5. An update never touches another product by itself

No version ranges, no automatic updates. Each product takes a new version by its own decision and in its own release. Order: one product
first; the others after a week of clean running.

## 6. No running central dependency

The library is code inside each product's process. Nothing in it calls V CODER's servers.
