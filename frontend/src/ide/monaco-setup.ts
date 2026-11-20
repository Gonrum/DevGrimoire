import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { registerDevGrimoireTheme } from './monaco-theme';

/**
 * Self-host Monaco from the bundled package instead of the default CDN loader. Workers are
 * bundled by Vite via `?worker` imports and served same-origin: the production CSP has no
 * `worker-src`, so neither CDN nor `blob:` workers would load.
 *
 * Import this module only from code inside the lazy IDE chunk.
 */
globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// Wire the bundled monaco into @monaco-editor/react FIRST — this is what gives the editor its
// languages, workers and syntax highlighting. It must run regardless of the optional tweaks below.
loader.config({ monaco });

registerDevGrimoireTheme(monaco);

/**
 * The in-browser TS/JS worker only knows the open models, not the workspace on disk, so it
 * cannot resolve sibling modules. Suppress the resulting single-file false positives — the
 * editor is not a full typechecker. 2792 (module resolution hint), 2307 (cannot find module),
 * 2305/2306 (no exported member / not a module), 2304 (cannot find name).
 *
 * monaco-editor 0.55 types the top-level `typescript` namespace properly, so no cast is needed.
 * Still wrapped defensively: an API shape change here must never break editor initialization.
 */
try {
  const diagnosticCodesToIgnore = [2792, 2307, 2305, 2306, 2304];
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), diagnosticCodesToIgnore });
    // Models carry their real file extension (see EditorPane), so .tsx/.jsx parse as JSX.
    defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), jsx: monaco.typescript.JsxEmit.Preserve });
  }
} catch {
  /* monaco TS defaults unavailable — single-file diagnostics suppression is best-effort */
}

export {};
