import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'drizzle/', 'deploy/', 'docker/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Nest modules are decorated empty classes.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // Nest injects constructor parameters by type, so they must stay value imports.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  // The design prototype's script is a plain browser script outside the TypeScript project.
  {
    files: ['design/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'script',
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'location',
          'localStorage',
          'navigator',
          'performance',
          'requestAnimationFrame',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  prettier,
);
