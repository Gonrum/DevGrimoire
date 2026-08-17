// ESLint-Konfiguration Frontend (M-52).
//
// Regelsatz: `recommended-type-checked` plus react-hooks und react-refresh.
// Die tsconfig ist hier schon `strict`, der Mehrwert von ESLint liegt deshalb
// vor allem in den Regeln, die tsc prinzipiell nicht sehen kann:
// Promise-Handling (no-floating-promises, no-misused-promises) und die
// Hook-Regeln.
//
// Grundsatz aus M-52: Regel-Abschaltungen gehören in diese Datei, mit
// Begründung. Keine zeilenweisen `eslint-disable`-Kommentare.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // Bei eslint-plugin-react-hooks v7 ist `configs.flat[...]` der Flat-Config-
  // Pfad. Die Top-Level-Variante `configs['recommended-latest']` liefert
  // `plugins` noch als Array (Legacy) und bricht unter ESLint 10 mit
  // "plugins must be an object" ab.
  reactHooks.configs.flat['recommended-latest'],
  reactRefresh.configs.vite,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * Über `recommended-type-checked` hinaus bewusst aktiviert — gleiche
       * Begründung wie im Backend: `x as never` und `x as unknown as T`
       * umgehen die Typprüfung, erzeugen aber kein `any` und bleiben damit für
       * `no-explicit-any` und die `no-unsafe-*`-Familie unsichtbar.
       */
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
    },
  },
);
