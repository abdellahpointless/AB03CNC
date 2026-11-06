import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Real part models (3D PDF, STL) the tests read as files.
  assetsInclude: ['**/*.stl'],
  test: {
    include: ['tests/**/*.test.ts', 'worker/tests/**/*.test.ts'],
    environment: 'node',
  },
});
