import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@v-coder/integration-kit': src('kit-core'),
      '@v-coder/connector-paymob': src('connector-paymob'),
      '@v-coder/connector-whatsapp': src('connector-whatsapp'),
      '@v-coder/delivery-kit': src('delivery-kit'),
      '@v-coder/foundation': src('foundation'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
