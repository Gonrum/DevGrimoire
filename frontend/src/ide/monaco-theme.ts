import type * as Monaco from 'monaco-editor';

export const DEVGRIMOIRE_THEME = 'devgrimoire-dark';

/*
 * Hex equivalents of the Tailwind 4 palette the app uses (Monaco needs hex):
 * gray-900 #101828, gray-800 #1e2939, gray-700 #364153, gray-500 #6a7282,
 * gray-200 #e5e7eb, cyan-400 #00d3f2.
 */
const GRAY_900 = '#101828';
const GRAY_800 = '#1e2939';
const GRAY_700 = '#364153';
const GRAY_500 = '#6a7282';
const GRAY_200 = '#e5e7eb';
const CYAN_400 = '#00d3f2';

/** Registers `devgrimoire-dark`: vs-dark syntax colours on the app's background and accent. */
export function registerDevGrimoireTheme(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(DEVGRIMOIRE_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': GRAY_900,
      'editor.foreground': GRAY_200,
      'editorCursor.foreground': CYAN_400,
      'editor.lineHighlightBackground': GRAY_800,
      'editor.lineHighlightBorder': GRAY_800,
      'editorLineNumber.foreground': GRAY_500,
      'editorLineNumber.activeForeground': CYAN_400,
      'editor.selectionHighlightBorder': '#00d3f240',
      'editorGutter.background': GRAY_900,
      'editorWidget.background': GRAY_800,
      'editorWidget.border': GRAY_700,
      'focusBorder': CYAN_400,
      'diffEditor.border': GRAY_700,
    },
  });
}
