// Inline file-type glyphs for the file tree (no icon dependency in the bundle).
// All glyphs share a 16×16 stroke grid; colors are static Tailwind classes.

type Glyph =
  | 'file'
  | 'text'
  | 'code'
  | 'braces'
  | 'hash'
  | 'terminal'
  | 'image'
  | 'archive'
  | 'database'
  | 'key'
  | 'git'
  | 'box';

interface IconSpec {
  glyph: Glyph;
  color: string;
}

const DOC = 'M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13';

const GLYPH_PATHS: Record<Glyph, string> = {
  file: DOC,
  text: `${DOC} M6 8h4.5 M6 10.5h4.5 M6 5.5h1.5`,
  code: 'M5.5 4.5 2 8l3.5 3.5 M10.5 4.5 14 8l-3.5 3.5 M9 3 7 13',
  braces:
    'M6 2.5c-1.5 0-2 .7-2 2V6c0 1-.6 1.6-1.5 2 .9.4 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2 M10 2.5c1.5 0 2 .7 2 2V6c0 1 .6 1.6 1.5 2-.9.4-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2',
  hash: 'M6.5 2.5 5 13.5 M11 2.5 9.5 13.5 M3 6h10.5 M2.5 10h10.5',
  terminal: 'M2.5 2.5h11v11h-11z M5 6l2 2-2 2 M8.5 10.5H11',
  image: 'M2.5 3h11v10h-11z M2.5 11.5l3.5-4 3 3 2-2 2.5 2.5 M10.5 4.75a1 1 0 1 0 0 2 1 1 0 1 0 0-2',
  archive: `${DOC} M7.5 3v1 M7.5 5.5v1 M7.5 8v1 M6.5 10h2v2.5h-2z`,
  database:
    'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2z M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4 M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  key: 'M5.5 7.5a3 3 0 1 0 0 6 3 3 0 1 0 0-6 M7.6 8.4 13.5 2.5 M11.5 4.5 13 6 M10 6l1 1',
  git: 'M4.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3 M4.5 11a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3 M11.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3 M4.5 5v6 M11.5 6.5c0 3-7 2-7 4.5',
  box: 'M8 1.8 13.5 4.8v6.4L8 14.2 2.5 11.2V4.8z M2.5 4.8 8 7.8l5.5-3 M8 7.8v6.4',
};

const BY_EXTENSION = new Map<string, IconSpec>();

function register(extensions: string[], glyph: Glyph, color: string): void {
  for (const ext of extensions) BY_EXTENSION.set(ext, { glyph, color });
}

register(['ts', 'tsx', 'mts', 'cts'], 'code', 'text-cyan-400');
register(['js', 'jsx', 'mjs', 'cjs'], 'code', 'text-yellow-400');
register(['py', 'rb', 'go', 'vue', 'svelte'], 'code', 'text-emerald-400');
register(['rs', 'java', 'kt', 'scala', 'swift', 'php'], 'code', 'text-rose-400');
register(['c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'lua', 'dart'], 'code', 'text-cyan-400');
register(['html', 'htm', 'xml'], 'code', 'text-rose-400');
register(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg'], 'braces', 'text-yellow-400');
register(['lock'], 'braces', 'text-gray-500');
register(['css', 'scss', 'sass', 'less', 'styl'], 'hash', 'text-cyan-400');
register(['md', 'mdx', 'txt', 'rst', 'adoc', 'log', 'pdf', 'csv', 'tsv'], 'text', 'text-gray-400');
register(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'], 'terminal', 'text-emerald-400');
register(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp'], 'image', 'text-emerald-400');
register(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'], 'archive', 'text-gray-400');
register(['sql', 'db', 'sqlite', 'sqlite3'], 'database', 'text-yellow-400');
register(['pem', 'key', 'crt', 'cer', 'p12', 'pfx'], 'key', 'text-rose-400');

/** Exact (lower-cased) file names that beat the extension lookup. */
const BY_NAME = new Map<string, IconSpec>(Object.entries({
  dockerfile: { glyph: 'box', color: 'text-cyan-400' },
  '.dockerignore': { glyph: 'box', color: 'text-gray-500' },
  'docker-compose.yml': { glyph: 'box', color: 'text-cyan-400' },
  'docker-compose.yaml': { glyph: 'box', color: 'text-cyan-400' },
  'compose.yml': { glyph: 'box', color: 'text-cyan-400' },
  'compose.yaml': { glyph: 'box', color: 'text-cyan-400' },
  '.gitignore': { glyph: 'git', color: 'text-rose-400' },
  '.gitattributes': { glyph: 'git', color: 'text-rose-400' },
  '.gitmodules': { glyph: 'git', color: 'text-rose-400' },
  makefile: { glyph: 'terminal', color: 'text-yellow-400' },
  license: { glyph: 'text', color: 'text-yellow-400' },
}));

function specFor(name: string): IconSpec {
  const lower = name.toLowerCase();
  const exact = BY_NAME.get(lower);
  if (exact) return exact;
  if (lower === '.env' || lower.startsWith('.env.')) return { glyph: 'key', color: 'text-rose-400' };
  if (lower.startsWith('dockerfile.')) return { glyph: 'box', color: 'text-cyan-400' };
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  const byExt = BY_EXTENSION.get(ext);
  return byExt ?? { glyph: 'file', color: 'text-gray-400' };
}

const SVG_PROPS = {
  'aria-hidden': true,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function FileIcon({ name }: { name: string }) {
  const { glyph, color } = specFor(name);
  return (
    <svg {...SVG_PROPS} className={`h-3.5 w-3.5 shrink-0 ${color}`}>
      <path d={GLYPH_PATHS[glyph]} />
    </svg>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg {...SVG_PROPS} className="h-3.5 w-3.5 shrink-0 text-amber-400">
      {open ? (
        <path
          d="M1.5 12V4.5a1 1 0 0 1 1-1h3.6l1.5 1.5h4.9a1 1 0 0 1 1 1V7 M1.5 12l2-4.5a1 1 0 0 1 .9-.5h9.6l-2.1 5a1 1 0 0 1-.9.5H2.5a1 1 0 0 1-1-1z"
          fill="currentColor"
          fillOpacity={0.15}
        />
      ) : (
        <path
          d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.5 1.5h5.4a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
          fill="currentColor"
          fillOpacity={0.15}
        />
      )}
    </svg>
  );
}
