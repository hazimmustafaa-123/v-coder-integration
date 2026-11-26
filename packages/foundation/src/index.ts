/**
 * @v-coder/foundation — what every V CODER product shares as code (shared-standards.md, «Shared build-time libraries»).
 * Import the part you need by its subpath (`@v-coder/foundation/data-io`, `/web-push`, `/attendance-days`, `/i18n`); the root re-exports them as
 * namespaces only, so names from different parts never collide.
 */
export * as dataIo from './data-io/index.js';
export * as webPush from './web-push.js';
export * as attendanceDays from './attendance-days.js';
export * as i18n from './i18n/index.js';
