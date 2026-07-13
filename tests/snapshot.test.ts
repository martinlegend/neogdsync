import { describe, it, expect } from 'vitest';
import { App } from 'obsidian';
import { VaultSnapshot } from '../src/snapshot';

interface FakeFile { path: string; stat: { mtime: number; size: number } }

function makeApp(files: FakeFile[]): App {
  return {
    vault: {
      configDir: '.obsidian',
      getFiles: () => files,
    },
  } as unknown as App;
}

const noExclude = () => false;

describe('VaultSnapshot.computeDiff', () => {
  it('detects created, modified and deleted files', () => {
    const files: FakeFile[] = [
      { path: 'kept.md', stat: { mtime: 1000, size: 10 } },
      { path: 'edited.md', stat: { mtime: 60_000, size: 20 } },
      { path: 'new.md', stat: { mtime: 1000, size: 5 } },
    ];
    const snap = new VaultSnapshot(makeApp(files));
    snap.setRaw({
      'kept.md': { mtime: 1000, size: 10 },
      'edited.md': { mtime: 1000, size: 10 },
      'gone.md': { mtime: 1000, size: 10 },
    });

    expect(snap.computeDiff(noExclude)).toEqual({
      'edited.md': 'modify',
      'new.md': 'create',
      'gone.md': 'delete',
    });
  });

  it('ignores mtime drift within 2s when size is unchanged', () => {
    const files: FakeFile[] = [{ path: 'a.md', stat: { mtime: 2500, size: 10 } }];
    const snap = new VaultSnapshot(makeApp(files));
    snap.setRaw({ 'a.md': { mtime: 1000, size: 10 } });
    expect(snap.computeDiff(noExclude)).toEqual({});
  });

  it('flags a size change even inside the mtime window', () => {
    const files: FakeFile[] = [{ path: 'a.md', stat: { mtime: 1500, size: 11 } }];
    const snap = new VaultSnapshot(makeApp(files));
    snap.setRaw({ 'a.md': { mtime: 1000, size: 10 } });
    expect(snap.computeDiff(noExclude)).toEqual({ 'a.md': 'modify' });
  });

  it('respects the exclude callback in both directions', () => {
    const files: FakeFile[] = [{ path: 'skip/new.md', stat: { mtime: 1, size: 1 } }];
    const snap = new VaultSnapshot(makeApp(files));
    snap.setRaw({ 'skip/old.md': { mtime: 1, size: 1 } });
    const exclude = (p: string) => p.startsWith('skip/');
    // Excluded paths generate no ops in either direction: a newly-excluded
    // snapshot entry stops being tracked, it was not deleted.
    expect(snap.computeDiff(exclude)).toEqual({});
  });

  it('setRaw purges config-dir entries', () => {
    const snap = new VaultSnapshot(makeApp([]));
    snap.setRaw({
      '.obsidian/workspace.json': { mtime: 1, size: 1 },
      'note.md': { mtime: 1, size: 1 },
    });
    expect(Object.keys(snap.getAll())).toEqual(['note.md']);
  });
});
