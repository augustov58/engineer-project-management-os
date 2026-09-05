import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The component-level suite (issue #50, ADR-0049).
 *
 * `jsdom` and nothing else: no API, no database, no Redis and no browser, so
 * `pnpm test` at the root runs this alongside the API's suite without either
 * one needing what the other needs. What that buys, and the four things it
 * deliberately does not cover, are written down in ADR-0049 rather than here.
 *
 * The `@/` alias is `tsconfig.json`'s `paths` entry said a second time,
 * because Vite resolves imports itself and never reads a tsconfig.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
