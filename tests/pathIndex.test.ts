import { describe, it, expect } from 'vitest';
import { App } from 'obsidian';
import { PathIndex } from '../src/pathIndex';
import { DriveApi } from '../src/driveApi';

/** In-memory DataAdapter covering what PathIndex uses. */
function makeApp(files: Map<string, string> = new Map()): { app: App; files: Map<string, string> } {
  const adapter = {
    exists: async (p: string) => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
    read: async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
    write: async (p: string, data: string) => { files.set(p, data); },
    remove: async (p: string) => { files.delete(p); },
    rename: async (from: string, to: string) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    mkdir: async (p: string) => { files.set(p + '/.dir', ''); },
  };
  const app = { vault: { adapter, configDir: '.obsidian' } } as unknown as App;
  return { app, files };
}

const fakeDrive = {} as DriveApi;
const entry = (driveId: string, isFolder = false) =>
  ({ driveId, driveMtime: '2026-01-01T00:00:00Z', syncedAt: 1, isFolder });

describe('PathIndex core ops', () => {
  it('set/get/delete/rename/allPaths', () => {
    const idx = new PathIndex(makeApp().app, fakeDrive, 'root');
    idx.set('a/b.md', entry('id1'));
    expect(idx.get('a/b.md')?.driveId).toBe('id1');

    idx.rename('a/b.md', 'a/c.md');
    expect(idx.get('a/b.md')).toBeUndefined();
    expect(idx.get('a/c.md')?.driveId).toBe('id1');

    expect(idx.allPaths()).toEqual(['a/c.md']);
    idx.delete('a/c.md');
    expect(idx.allPaths()).toEqual([]);
  });
});

describe('PathIndex persistence', () => {
  it('round-trips through save/load', async () => {
    const { app, files } = makeApp();
    const idx = new PathIndex(app, fakeDrive, 'root');
    idx.set('n.md', entry('id9'));
    await idx.save();

    expect(files.has('.neogdsync/index.db')).toBe(true);
    expect(files.has('.neogdsync/index.db.tmp')).toBe(false);

    const idx2 = new PathIndex(app, fakeDrive, 'root');
    await idx2.load();
    expect(idx2.get('n.md')?.driveId).toBe('id9');
  });

  it('recovers from a crash that left only the .tmp file', async () => {
    const { app, files } = makeApp();
    files.set('.neogdsync/index.db.tmp', JSON.stringify({ 'x.md': entry('idX') }));

    const idx = new PathIndex(app, fakeDrive, 'root');
    await idx.load();
    expect(idx.get('x.md')?.driveId).toBe('idX');
  });

  it('falls back to .tmp when the main index is corrupt', async () => {
    const { app, files } = makeApp();
    files.set('.neogdsync/index.db', '{not json');
    files.set('.neogdsync/index.db.tmp', JSON.stringify({ 'y.md': entry('idY') }));

    const idx = new PathIndex(app, fakeDrive, 'root');
    await idx.load();
    expect(idx.get('y.md')?.driveId).toBe('idY');
  });

  it('starts empty when nothing is readable', async () => {
    const idx = new PathIndex(makeApp().app, fakeDrive, 'root');
    await idx.load();
    expect(idx.allPaths()).toEqual([]);
  });
});
