import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Next.js `import 'server-only'` errors at module load when bundled into
      // client code. Vitest loads everything in one happy-dom context, so alias
      // it to a no-op shim — server-side modules can be imported in tests
      // without a bundle-context crash.
      'server-only': path.resolve(__dirname, 'vitest.server-only-shim.ts'),
    },
  },
})
