import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

/**
 * The admin client (`src/lib/supabase/admin.ts`) is built with
 * SUPABASE_SERVICE_ROLE_KEY and bypasses RLS. It is `server-only`-guarded at
 * runtime, but we also bar it at lint time from the public route group and from
 * any client component so a leak is caught before it reaches a browser bundle.
 *
 * Two layers, on purpose:
 *   - this lint rule (fast, local, fails `pnpm lint`)
 *   - the import-barrier test in __tests__/admin-import-barrier.test.ts (scans
 *     every `'use client'` file regardless of location).
 */
const adminImportRestriction = {
  name: '@/lib/supabase/admin',
  message:
    'The service-role admin client bypasses RLS and must stay server-only. ' +
    'Do not import it from a client component or the public (public) route group. ' +
    'Use it only in Server Components, Server Actions, or Route Handlers under src/app/api/**.',
}

const config = [
  ...nextVitals,
  ...nextTypeScript,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'out/**',
      'next-env.d.ts',
      'tsconfig.tsbuildinfo',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // The public showcase route group is unauthenticated and anon-only — it must
    // never reach the service-role admin client.
    files: ['src/app/(public)/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [adminImportRestriction] }],
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
]

export default config
