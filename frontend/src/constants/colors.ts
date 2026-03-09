import { SearchResult } from '../api/client';

export const ENV_COLORS: Record<string, string> = {
  dev: 'bg-green-900/40 text-green-300',
  development: 'bg-green-900/40 text-green-300',
  staging: 'bg-yellow-900/40 text-yellow-300',
  prod: 'bg-red-900/40 text-red-300',
  production: 'bg-red-900/40 text-red-300',
};

export const SECRET_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  variable: { label: 'Variable', color: 'bg-gray-700 text-gray-300' },
  password: { label: 'Passwort', color: 'bg-orange-900/40 text-orange-300' },
  token: { label: 'Token', color: 'bg-purple-900/40 text-purple-300' },
  ssh_key: { label: 'SSH Key', color: 'bg-cyan-900/40 text-cyan-300' },
  certificate: { label: 'Zertifikat', color: 'bg-yellow-900/40 text-yellow-300' },
  file: { label: 'Datei', color: 'bg-blue-900/40 text-blue-300' },
};

export const TYPE_LABELS: Record<SearchResult['type'], string> = {
  todo: 'Todo',
  knowledge: 'Wissen',
  changelog: 'Changelog',
  research: 'Recherche',
  milestone: 'Milestone',
};

export const TYPE_COLORS: Record<SearchResult['type'], string> = {
  todo: 'bg-yellow-900 text-yellow-300',
  knowledge: 'bg-blue-900 text-blue-300',
  changelog: 'bg-green-900 text-green-300',
  research: 'bg-purple-900 text-purple-300',
  milestone: 'bg-orange-900 text-orange-300',
};

export const ENTITY_ICONS: Record<string, string> = {
  todo: '\u2611',
  milestone: '\u{1F3AF}',
  session: '\u{1F4DD}',
  knowledge: '\u{1F4A1}',
  changelog: '\u{1F4CB}',
  project: '\u2699',
};

export const ACTION_COLORS: Record<string, string> = {
  created: 'text-green-400',
  updated: 'text-blue-400',
  deleted: 'text-red-400',
};
