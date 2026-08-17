// ESLint-Konfiguration Backend (M-52).
//
// Regelsatz: `recommended-type-checked` — typed linting, also mit
// Typinformationen aus der tsconfig. Das kostet Laufzeit, ist aber der Grund,
// warum Regeln wie no-floating-promises überhaupt greifen können.
//
// Bewusst NICHT aktiv: Stylistic- und Komplexitätsregeln. mcp-tools.ts hat über
// 5.000 Zeilen; jede max-lines-artige Regel wäre reines Rauschen.
//
// Grundsatz aus M-52: Regel-Abschaltungen gehören in diese Datei, mit
// Begründung. Zeilenweise `eslint-disable`-Kommentare sind im Projekt nicht
// erwünscht — eine Regel, die nicht tragfähig ist, wird hier einmal
// abgeschaltet statt an hundert Stellen unterdrückt.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      // Die .cjs-Checks liegen außerhalb der tsconfig und brauchen einen
      // eigenen Config-Block (CommonJS, Node-Globals) — kommt in T-452.
      'scripts/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * Über `recommended-type-checked` hinaus bewusst aktiviert.
       *
       * Grund: `recommended-type-checked` hat einen blinden Fleck. `x as never`
       * und `x as unknown as T` erzeugen kein `any`, also schweigen
       * `no-explicit-any` und die ganze `no-unsafe-*`-Familie — obwohl die
       * Typprüfung an der Stelle vollständig umgangen wird. Gemessen waren das
       * 63× `as never` und 53× `as unknown as` im Backend, davon 29 allein in
       * `chat-tools.ts`, wo darüber ungeprüfte LLM-Strings in Service-Enums
       * liefen. Die Datei stand dabei auf null Findings.
       *
       * Ohne diese Regel wäre „null Findings" also kein belastbares Ziel: das
       * Gate würde eine Klasse durchlassen, die riskanter ist als das, was es
       * fängt.
       */
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
    },
  },
);
