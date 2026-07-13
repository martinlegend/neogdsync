import { describe, it, expect } from 'vitest';
import { isExcluded, matchGlob } from '../src/exclude';

describe('matchGlob', () => {
  it('matches ** across directories', () => {
    expect(matchGlob('.smart-env/**', '.smart-env/a/b.md')).toBe(true);
    expect(matchGlob('**/node_modules/**', 'a/node_modules/x.js')).toBe(true);
  });

  it('single * does not cross directories', () => {
    expect(matchGlob('notes/*.md', 'notes/a.md')).toBe(true);
    expect(matchGlob('notes/*.md', 'notes/sub/a.md')).toBe(false);
  });

  it('? matches a single non-slash character', () => {
    expect(matchGlob('a?.md', 'ab.md')).toBe(true);
    expect(matchGlob('a?.md', 'a/.md')).toBe(false);
  });

  it('escapes regex metacharacters in patterns', () => {
    expect(matchGlob('a+b.md', 'a+b.md')).toBe(true);
    expect(matchGlob('a+b.md', 'aab.md')).toBe(false);
  });
});

describe('isExcluded', () => {
  const config = '.obsidian';

  it('excludes built-in plugin/config paths', () => {
    expect(isExcluded('.neogdsync/index.db', config, [])).toBe(true);
    expect(isExcluded('.neogdsync', config, [])).toBe(true);
    expect(isExcluded('.obsidian/workspace.json', config, [])).toBe(true);
    expect(isExcluded('sub/.git/HEAD', config, [])).toBe(true);
    expect(isExcluded('a/node_modules/b.js', config, [])).toBe(true);
    expect(isExcluded('photo.DS_Store', config, [])).toBe(true);
  });

  it('does not exclude look-alike prefixes', () => {
    expect(isExcluded('.neogdsync-notes/a.md', config, [])).toBe(false);
    expect(isExcluded('.obsidian-tips.md', config, [])).toBe(false);
  });

  it('applies user glob patterns', () => {
    expect(isExcluded('Templates/daily.md', config, ['Templates/**'])).toBe(true);
    expect(isExcluded('notes/a.md', config, ['Templates/**'])).toBe(false);
  });
});
