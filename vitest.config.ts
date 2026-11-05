import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/storage.ts',
        'src/authorization.ts',
        'src/errors.ts',
        'src/mime.ts',
        'src/schemas.ts',
      ],
      thresholds: { lines: 80, functions: 70, statements: 75, branches: 60 },
    },
  },
});
