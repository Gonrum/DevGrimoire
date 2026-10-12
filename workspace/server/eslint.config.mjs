import js from '@eslint/js';
import globals from 'globals';

/**
 * Lint für den Workspace-Sidecar (M-30). `index.js` ist sicherheitskritischer
 * Code — Shell-Ausführung, PTY, Kube-Sessions — und wurde bisher von keinem
 * Linter erfasst. Kein TypeScript, also kein typed linting: der empfohlene
 * Regelsatz deckt unerreichbaren Code, ungenutzte Variablen, doppelte Keys und
 * versehentliche Globals ab.
 *
 * Wie in Backend und Frontend: Regel-Ausnahmen gehören hierher, mit
 * Begründung — nicht als eslint-disable in die Zeile.
 */
export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // `_arg` ist die Konvention für bewusst ungenutzte Parameter
      // (Express-Signaturen wie (req, res, _next)).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { sourceType: 'module' },
  },
];
