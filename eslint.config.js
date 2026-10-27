import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Eigene Regel: Sichtbare Texte gehören in src/locales, nicht in JSX.
// Gemeldet werden Textknoten und Attribute wie title/aria-label/placeholder/alt mit Buchstaben.
const noLiteralUiText = {
  meta: { type: 'problem', messages: { literal: 'UI-Text gehört in src/locales/de/translation.json: "{{text}}"' } },
  create(context) {
    const LETTER = /\p{L}/u;
    const UI_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (text && LETTER.test(text)) context.report({ node, messageId: 'literal', data: { text } });
      },
      JSXAttribute(node) {
        const name = typeof node.name.name === 'string' ? node.name.name : '';
        if (!UI_ATTRIBUTES.has(name) || node.value?.type !== 'Literal') return;
        const text = String(node.value.value).trim();
        if (text && LETTER.test(text)) context.report({ node, messageId: 'literal', data: { text } });
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', '.tools/**', 'node_modules/**', 'src/renderer/public/**', 'test/fixtures/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'ios/build/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: 'ExportDefaultDeclaration', message: 'Benannte Exporte verwenden.' }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, local: { rules: { 'no-literal-ui-text': noLiteralUiText } } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'local/no-literal-ui-text': 'error',
    },
  },
  {
    // CommonJS-Hilfsskripte (electron-builder-Hook, Symbol-Erzeugung)
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Konfigurationsdateien von Werkzeugen verlangen Default-Exporte.
    files: ['*.config.{ts,js}', 'eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
