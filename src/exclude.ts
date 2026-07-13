/**
 * Shared path-exclusion logic used by both the vault event handlers (main.ts)
 * and the sync engine (syncer.ts), so the two can never disagree about what
 * is synced. Built-in exclusions cover plugin state, the Obsidian config dir,
 * and common junk; user patterns come from settings.excludePaths.
 */

export function isExcluded(path: string, configDir: string, patterns: string[]): boolean {
  if (path === '.neogdsync' || path.startsWith('.neogdsync/')) return true;
  if (path === configDir || path.startsWith(configDir + '/')) return true;
  if (path === '.smart-env' || path.startsWith('.smart-env/')) return true;
  if (path.startsWith('.smtcmp')) return true;
  if (path.endsWith('.DS_Store')) return true;
  if (path === '.git' || path.startsWith('.git/') || path.includes('/.git/')) return true;
  if (path.includes('node_modules/')) return true;
  for (const pat of patterns) {
    if (matchGlob(pat, path)) return true;
  }
  return false;
}

export function matchGlob(pattern: string, path: string): boolean {
  let r = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*';
      i++;
    } else if (c === '*') {
      r += '[^/]*';
    } else if (c === '?') {
      r += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      r += '\\' + c;
    } else {
      r += c;
    }
  }
  return new RegExp('^' + r + '$').test(path);
}
