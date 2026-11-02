import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@gitroom/nestjs-libraries': resolve(
        root,
        'libraries/nestjs-libraries/src'
      ),
      '@gitroom/helpers': resolve(root, 'libraries/helpers/src'),
    },
  },
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
