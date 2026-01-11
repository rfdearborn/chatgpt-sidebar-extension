import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.js'],
    globals: true,
    exclude: ['**/node_modules/**', '**/tests/e2e/**'],
  },
});
