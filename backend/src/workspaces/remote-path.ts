import { BadRequestException } from '@nestjs/common';

export const REMOTE_PATH_MAX = 4096;

/**
 * Validates and normalises the absolute directory of an SSH workspace.
 *
 * Rejects non-strings, relative paths (`~` is deliberately not expanded),
 * NUL, `..` segments, over-long input and the filesystem root (a tree or
 * search over `/` is no sensible working place). Duplicate and trailing
 * slashes and `.` segments are removed.
 */
export function normalizeRemotePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('remotePath must be a string');
  }
  if (value.length > REMOTE_PATH_MAX) {
    throw new BadRequestException(`remotePath must not exceed ${REMOTE_PATH_MAX} characters`);
  }
  if (value.includes('\0')) {
    throw new BadRequestException('remotePath must not contain NUL');
  }
  if (!value.startsWith('/')) {
    throw new BadRequestException('remotePath must be an absolute path (starting with "/")');
  }
  const segments = value.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new BadRequestException('remotePath must not contain ".." segments');
  }
  if (segments.length === 0) {
    throw new BadRequestException('remotePath must not be the filesystem root');
  }
  return `/${segments.join('/')}`;
}
