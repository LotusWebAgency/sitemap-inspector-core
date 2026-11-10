import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const bannedSyntax = [
  { selector: "CallExpression[callee.name='eval']", message: 'eval is banned' },
  { selector: "NewExpression[callee.name='Function']", message: 'new Function is banned' },
  { selector: "CallExpression[callee.name='Function']", message: 'Function() is banned' },
  { selector: "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(globalThis|window|self)$/][callee.property.name='eval']", message: 'eval is banned' },
  { selector: "CallExpression > SequenceExpression.callee > Identifier[name='eval']:last-child", message: 'indirect eval is banned' },
  { selector: "NewExpression[callee.type='MemberExpression'][callee.object.name=/^(globalThis|window|self)$/][callee.property.name='Function']", message: 'new Function is banned' },
  { selector: "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(globalThis|window|self)$/][callee.property.name='Function']", message: 'Function() is banned' },
  { selector: "NewExpression[callee.type='MemberExpression'][callee.object.name=/^(globalThis|window|self)$/][callee.property.name='DOMParser']", message: 'never DOMParser for sitemaps (streaming invariant)' },
  { selector: "NewExpression[callee.name='DOMParser']", message: 'never DOMParser for sitemaps (streaming invariant)' },
  { selector: "CallExpression[callee.name=/^(setTimeout|setInterval)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]", message: 'a string argument to setTimeout/setInterval is dynamic code' },
  { selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(setTimeout|setInterval)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]", message: 'a string argument to setTimeout/setInterval is dynamic code' },
  { selector: 'WithStatement', message: '`with` is banned' },
];
const bannedGlobals = ['event', 'name', 'length', 'top', 'parent', 'self', 'origin'].map((name) => ({
  name,
  message: `bare \`${name}\` is a window global (usually a typo for a local): use globalThis.${name} if you mean it`,
}));
// The engine runs anywhere with fetch and streams (Node, workers, service workers): no page, no sync storage.
const offDomGlobals = ['window', 'document', 'localStorage', 'sessionStorage', 'alert'].map((name) => ({
  name,
  message: `\`${name}\` does not exist where the engine runs: keep it out of src/`,
}));
// Node-only: the engine also runs in workers and the browser, so src/ leaves these to the host (tests may use them).
const offNodeGlobals = ['process', 'Buffer', 'require', '__dirname', '__filename', 'global'].map((name) => ({
  name,
  message: `\`${name}\` is Node-only and the engine runs elsewhere too: keep it out of src/`,
}));

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // these are in strictTypeChecked/stylisticTypeChecked already; pinned so a preset change cannot drop them
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/strict-boolean-expressions': ['error', { allowNullableString: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error', ...bannedSyntax],
      'no-restricted-globals': ['error', ...bannedGlobals],
    },
  },
  {
    files: ['src/**'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', ...bannedGlobals, ...offDomGlobals, ...offNodeGlobals],
      // Hostile-input code is reviewed line by line: wrap before 160 columns.
      'max-len': ['error', { code: 160, ignoreUrls: true, ignoreRegExpLiterals: true }],
    },
  },
  {
    // `!` is the sanctioned pattern for index access under noUncheckedIndexedAccess
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // vitest mocks and spies are passed around as bare methods
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off', // `vi.fn(() => {})` stubs
      '@typescript-eslint/require-await': 'off', // async mock implementations that return a value synchronously
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },
);
