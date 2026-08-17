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
  {
    /*
     * Der einzige Override zu obiger Regel, und er gilt einer klar umrissenen
     * Rolle: **Grenz-Leser**. Das sind Funktionen, die ungeprüftes JSON in
     * getypte Formen überführen und dabei zur Laufzeit nur die *Form* prüfen
     * (String, Objekt, Array) — die Element-Struktur validiert erst die Schicht
     * dahinter (class-validator, Mongoose).
     *
     * - `src/common/tool-args.ts` — von einem LLM erzeugte Tool-Argumente
     * - `src/commits/providers/provider-responses.ts` — HTTP-Antworten von
     *   GitHub/GitLab/Gitea (`readJsonArray`/`readJsonObject`)
     *
     * Solange dort kein Schema-Validator dazwischensteht, ist eine Behauptung
     * unvermeidbar. Der Grundsatz aus M-52 bleibt gewahrt: die Ausnahme steht
     * begründet in der Config und betrifft zwei benannte Dateien — statt als
     * `eslint-disable` in den hunderten Aufrufern zu verschwinden.
     *
     * **Diese Liste ist keine Ablage für Unbequemlichkeiten.** Neue Einträge nur,
     * wenn die Datei tatsächlich diese Rolle hat: eine Laufzeit-Formprüfung
     * direkt vor der Behauptung, und ein Kommentar der begründet, warum keine
     * echte Typisierung möglich ist. Wer die Ausnahme ganz schließen will,
     * braucht einen Validator an der Grenze (zod o.ä.), nicht mehr Casts.
     */
    files: ['src/common/tool-args.ts', 'src/commits/providers/provider-responses.ts'],
    rules: { '@typescript-eslint/no-unsafe-type-assertion': 'off' },
  },
);
