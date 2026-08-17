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
    /*
     * Build- und Laufzeit-Dateien ausserhalb der tsconfig: `vite.config.ts`,
     * `postcss.config.js`, `tailwind.config.js` und der Service Worker
     * `public/sw.js`.
     *
     * Ohne eigenen Block scheitert das typed linting an ihnen mit
     * "was not found by the project service" — ein *fataler* Parse-Fehler, also
     * keine Fundstelle, die man wegarbeiten könnte. Bisher fielen sie schlicht
     * aus dem Lint heraus, weil das Skript nur `src` prüfte.
     *
     * `disableTypeChecked` nimmt die typ-abhängigen Regeln zurück; was bleibt,
     * ist `js.configs.recommended` — für einen Service Worker durchaus
     * relevant (unerreichbarer Code, ungenutzte Variablen, doppelte Keys).
     */
    files: ['*.config.js', '*.config.ts', 'public/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        // sw.js läuft im ServiceWorkerGlobalScope, die Config-Dateien in Node.
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        process: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // Gleiche Begründung wie im Backend: `.js` in einem Verzeichnis ohne
      // `"type": "module"` ist CommonJS, `require` ist dort korrekt.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
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
  {
    /*
     * Der einzige Override, und er gilt derselben Rolle wie im Backend:
     * **Grenz-Leser**. `src/api/http-boundary.ts` ist die eine Stelle, an der
     * aus einer ungeprüften JSON-Antwort ein getypter Wert wird.
     *
     * Bewusst eine eigene Mini-Datei statt `client.ts`: dort hängen 3.833 Zeilen
     * API-Oberfläche dran, die keine Ausnahme brauchen sollen.
     *
     * Diese Liste ist keine Ablage für Unbequemlichkeiten. Wer die Ausnahme
     * schliessen will, braucht einen Schema-Validator an der Grenze (zod o.ä.),
     * nicht mehr Casts.
     */
    files: ['src/api/http-boundary.ts'],
    rules: { '@typescript-eslint/no-unsafe-type-assertion': 'off' },
  },
);
