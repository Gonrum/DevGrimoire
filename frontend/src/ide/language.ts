const MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  sql: 'sql',
  xml: 'xml',
  toml: 'ini',
};

/** Maps a file extension to a Monaco language id (Monaco ships these grammars). */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MAP[ext] ?? 'plaintext';
}

export function isMarkdownPath(path: string): boolean {
  return languageFromPath(path) === 'markdown';
}
