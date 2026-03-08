import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const isProduction = process.env.NODE_ENV === 'production';

export default [
  {
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': typescriptEslint
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      ...typescriptEslint.configs.recommended.rules,
      'prefer-promise-reject-errors': 'error',
      'max-len': [
        'error',
        {
          code: 200,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: true
        }
      ],
      quotes: [
        'error',
        'single',
        {
          avoidEscape: true,
          allowTemplateLiterals: false
        }
      ],
      semi: [2, 'always'],
      'comma-dangle': ['error', 'never'],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      'no-debugger': isProduction ? 'error' : 'off',
      'array-element-newline': [
        'error',
        {
          ArrayExpression: 'consistent',
          ArrayPattern: { minItems: 3 }
        }
      ],
      'no-console': isProduction
        ? ['error', { allow: ['info', 'warn', 'error'] }]
        : ['warn', { allow: ['log', 'debug', 'info', 'warn', 'error'] }],
      'no-unused-vars': 'off',
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_.*$',
          varsIgnorePattern: '^_.*$',
          caughtErrorsIgnorePattern: '^_.*$'
        }
      ]
    }
  }
];
