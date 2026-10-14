import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Security rules tests. They need the Firestore + Realtime Database emulators:
//   npm run test:rules   (wraps vitest in `firebase emulators:exec`)
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['firebase/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
