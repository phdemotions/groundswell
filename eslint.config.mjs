import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

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
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
]

export default config
