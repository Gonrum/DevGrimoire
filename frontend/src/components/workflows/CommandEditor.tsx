import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tags } from '@lezer/highlight';
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { commandDiagnostics } from '../../lib/command-diagnostics';
import type { PlaceholderTrace } from '../../lib/placeholder-view';
import type { TemplateOption } from './TemplatePicker';

interface Props {
  value: string;
  onChange: (v: string) => void;
  templateOptions: TemplateOption[];
  placeholders?: PlaceholderTrace[];
  issues?: string[];
}

/** Zeilenhöhe in px; Min/Max-Höhe des Editors (6–20 Zeilen) leiten sich daraus ab. */
const LINE_PX = 19;
const MIN_LINES = 6;
const MAX_LINES = 20;

/** Stabile Referenz, damit der Default nicht bei jedem Render neue Diagnosen auslöst. */
const NO_TRACES: PlaceholderTrace[] = [];

const PLACEHOLDER_RE = /\{\{\{?[^{}\n]*\}\}\}?/g;

const placeholderMark = Decoration.mark({ class: 'cm-dg-placeholder' });
const secretMark = Decoration.mark({ class: 'cm-dg-secret' });

const placeholderMatcher = new MatchDecorator({
  regexp: PLACEHOLDER_RE,
  decoration: (match) => (/^\{\{\{?\s*secrets\./.test(match[0]) ? secretMark : placeholderMark),
});

const placeholderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = placeholderMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = placeholderMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Farben als Tailwind-Grautöne/-Akzente (gray-900/800/200, cyan, amber), damit der
// Editor zu den übrigen Eingabefeldern passt. Hier als CSS, nicht als Tailwind-Klassen:
// CodeMirror erzeugt seine Knoten selbst.
const theme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#1f2937',
      color: '#e5e7eb',
      fontSize: '13px',
      border: '1px solid #374151',
      borderRadius: '2px',
      minHeight: `${MIN_LINES * LINE_PX + 8}px`,
      maxHeight: `${MAX_LINES * LINE_PX + 8}px`,
    },
    '&.cm-focused': { outline: 'none', borderColor: '#06b6d4' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: `${LINE_PX}px`, overflow: 'auto' },
    '.cm-content': { caretColor: '#e5e7eb', padding: '4px 0', minHeight: `${MIN_LINES * LINE_PX}px` },
    '.cm-cursor': { borderLeftColor: '#e5e7eb' },
    '.cm-gutters': { backgroundColor: '#111827', color: '#6b7280', border: 'none', borderRight: '1px solid #374151' },
    '.cm-activeLine': { backgroundColor: 'rgba(55, 65, 81, 0.35)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(55, 65, 81, 0.5)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(6, 182, 212, 0.3)' },
    '.cm-dg-placeholder': { color: '#67e8f9', backgroundColor: 'rgba(6, 182, 212, 0.15)', borderRadius: '2px' },
    '.cm-dg-secret': { color: '#fcd34d', backgroundColor: 'rgba(245, 158, 11, 0.18)', borderRadius: '2px' },
    '.cm-tooltip': { backgroundColor: '#111827', border: '1px solid #374151', color: '#e5e7eb' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#374151', color: '#e5e7eb' },
    '.cm-completionDetail': { color: '#9ca3af', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-diagnostic': { color: '#e5e7eb' },
  },
  { dark: true },
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c4b5fd' },
  { tag: [tags.string, tags.special(tags.string)], color: '#86efac' },
  { tag: tags.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: [tags.number, tags.atom], color: '#fdba74' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: '#93c5fd' },
  { tag: [tags.operator, tags.punctuation], color: '#9ca3af' },
]);

/** Autovervollständigung nach `{{` bzw. `{{{`: Pfade aus den Template-Optionen. */
function templateCompletion(getOptions: () => TemplateOption[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\{\{\{?[\w.-]*/);
    if (!match) return null;
    const braces = match.text.startsWith('{{{') ? 3 : 2;
    const closing = '}'.repeat(braces);
    const after = context.state.doc.sliceString(context.pos, context.pos + braces);
    return {
      from: match.from + braces,
      options: getOptions().map((opt) => ({
        label: opt.path,
        detail: opt.type ? `${opt.label} · ${opt.type}` : opt.label,
        type: opt.type === 'secret' ? 'keyword' : 'variable',
        // Schliessende Klammern nur ergänzen, wenn sie noch nicht dastehen.
        apply: after === closing ? opt.path : opt.path + closing,
      })),
      validFor: /^[\w.-]*$/,
    };
  };
}

export function CommandEditor({ value, onChange, templateOptions, placeholders = NO_TRACES, issues = [] }: Props) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Aktuelle Werte für die einmalig erzeugten Erweiterungen (Autocomplete, Linter, onChange);
  // so muss der EditorView bei Prop-Änderungen nicht neu aufgebaut werden.
  const onChangeRef = useRef(onChange);
  const optionsRef = useRef(templateOptions);
  const placeholdersRef = useRef(placeholders);
  useEffect(() => {
    onChangeRef.current = onChange;
    optionsRef.current = templateOptions;
    tRef.current = t;
  }, [onChange, templateOptions, t]);

  // EditorView einmal pro Mount; Cleanup zerstört ihn (React 19 StrictMode mountet doppelt).
  // `value` wird hier bewusst nur als Startwert gelesen, spätere Änderungen gleicht der nächste Effect ab.
  const initialValue = useRef(value);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          StreamLanguage.define(shell),
          syntaxHighlighting(highlightStyle),
          placeholderPlugin,
          autocompletion({ override: [templateCompletion(() => optionsRef.current)], icons: false }),
          linter(
            (v): Diagnostic[] => {
              const doc = v.state.doc;
              return commandDiagnostics(doc.toString(), placeholdersRef.current).map((d) => {
                const line = doc.line(Math.min(Math.max(d.line, 1), doc.lines));
                return { from: line.from, to: line.to, severity: d.severity, message: tRef.current(`workflows.commandEditor.diag.${d.code}`, { expr: d.expr ?? '', defaultValue: d.message }) };
              });
            },
            { delay: 250 },
          ),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Externe Wertänderungen (Template-Picker, Wechsel des Nodes) übernehmen — nur wenn sie
  // vom Editorinhalt abweichen, sonst würde jeder Tastendruck den Cursor zurücksetzen.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // Neue Spuren aus der Vorschau -> Diagnosen sofort neu berechnen.
  useEffect(() => {
    placeholdersRef.current = placeholders;
    const view = viewRef.current;
    if (view) forceLinting(view);
  }, [placeholders, t]);

  return (
    <div>
      <div ref={hostRef} data-testid="command-editor" />
      {issues.length > 0 && (
        <ul className="mt-1 text-xs text-amber-300">
          {issues.map((iss) => <li key={iss}>⚠ {iss}</li>)}
        </ul>
      )}
    </div>
  );
}
