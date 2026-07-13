import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // The real `obsidian` package is types-only (no runtime JS), so tests run
    // against a minimal stub of the APIs the plugin touches.
    alias: { obsidian: resolve(__dirname, 'tests/obsidian-stub.ts') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
