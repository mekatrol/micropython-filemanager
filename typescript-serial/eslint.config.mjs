import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    ignores: ['dist/**/*'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': [
        'error',
        {
          // For example, allow:
          // export interface FlowBlockPointerEvent extends FlowPointerEvent<FlowBlock> {}
          // as it is the equivalent of:
          // export type FlowBlockPointerEvent = FlowPointerEvent<FlowBlock>
          allowInterfaces: 'with-single-extends'
        }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_.*$',
          varsIgnorePattern: '^_.*$',
          caughtErrorsIgnorePattern: '^_.*$'
        }
      ],

      'array-element-newline': [
        'error',
        {
          ArrayExpression: 'consistent',
          ArrayPattern: { minItems: 10 }
        }
      ],

      // Should use 'const' and 'let', but not 'var' for declaration variables
      // 'var' has global scope!
      'no-var': 'error',

      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'prefer-promise-reject-errors': 'error',
      'max-len': [
        'error',
        200,
        {
          /* SVG path can sometimes be really long*/
          ignorePattern: '^\\s*:d="',

          // Ignore long URLs
          ignoreUrls: true
        }
      ],

      // An error not to use single quotes
      quotes: [
        'error',
        'single',
        {
          // If strings contain quotes within string then either quote style can be used
          // eg: 'single containing "double"' or "double containing 'single'"
          avoidEscape: true,

          // Template (back tick quote) literals are not allowed
          // Back tick (interpolation) strings must have at least one parameter to be valid
          // eg must use 'literal' and not `literal`, but `literal ${param}` is OK
          allowTemplateLiterals: false
        }
      ],
      semi: ['error', 'always'],
      'comma-dangle': ['error', 'never'],
      'no-console': ['warn', { allow: ['info', 'warn', 'error'] }]
    }
  },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended
];
