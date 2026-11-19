import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Real part models (3D PDF, STL) the tests read as files.
  assetsInclude: ['**/*.stl'],
  test: {
    include: ['tests/**/*.test.ts', 'worker/tests/**/*.test.ts'],
    environment: 'node',
    // The signed-in app's translations (the public page loads only the sign-in words).
    setupFiles: ['src/i18n/appLocales.ts'],
  },
});
