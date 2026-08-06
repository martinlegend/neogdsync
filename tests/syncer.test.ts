import { describe, it, expect, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { Syncer } from '../src/syncer';
import { PathIndex } from '../src/pathIndex';
import { VaultSnapshot } from '../src/snapshot';
import { DriveApi } from '../src/driveApi';
import { DEFAULT_SETTINGS, PendingOps, DriveFileInfo } from '../src/types';

/**
 * Regression test for the duplicate-file bug: a 'create' pendingOp for a path
 * with no local index entry (e.g. a device whose index never learned about a
 * file another device already pushed) used to skip the Drive same-name lookup
 * that 'modify' already did, silently uploading a second file with the same
 * name instead of updating the existing one — and never surfacing a conflict,
 * since conflict detection only fires for paths already in the local index.
 */
function makeFakeApp(vaultFiles: Map<string, TFile>): App {
  const adapter = {
    exists: async () => false,
    read: async () => { throw new Error('ENOENT'); },
    write: async () => {},
    remove: async () => {},
    rename: async () => {},
    mkdir: async () => {},
  };
  return {
    vault: {
      adapter,
      configDir: '.obsidian',
      getAbstractFileByPath: (p: string) => vaultFiles.get(p) ?? null,
      readBinary: async () => new ArrayBuffer(0),
      getFiles: () => [...vaultFiles.values()],
    },
  } as unknown as App;
}

function makeFile(path: string, name: string, mtime = 1000): TFile {
  const f = new TFile();
  f.path = path;
  f.name = name;
  f.stat = { mtime, size: 5 };
  return f;
}

describe('Syncer.handlePush — create op with no index entry', () => {
  it('updates the existing Drive file instead of uploading a duplicate', async () => {
    const vaultFiles = new Map([['note.md', makeFile('note.md', 'note.md')]]);
    const app = makeFakeApp(vaultFiles);

    const existing: DriveFileInfo = {
      id: 'EXISTING_ID',
      name: 'note.md',
      mimeType: 'text/markdown',
      modifiedTime: '2026-01-01T00:00:00.000Z',
    };

    const uploadFile = vi.fn().mockResolvedValue('NEW_ID_SHOULD_NOT_BE_CREATED');
    const updateFile = vi.fn().mockResolvedValue('EXISTING_ID');
    const drive = {
      listChildren: vi.fn().mockResolvedValue([existing]),
      uploadFile,
      updateFile,
      pruneRevisions: vi.fn().mockResolvedValue(undefined),
    } as unknown as DriveApi;

    const index = new PathIndex(app, drive, 'ROOT_ID');
    const snapshot = new VaultSnapshot(app);
    const pendingOps: PendingOps = { 'note.md': 'create' };
    const settings = { ...DEFAULT_SETTINGS, keepRevisions: false, changesToken: 'tok' };

    const syncer = new Syncer(app, drive, index, snapshot, settings, pendingOps, () => {});
    const result = await syncer.forcePush();

    expect(uploadFile).not.toHaveBeenCalled();
    expect(updateFile).toHaveBeenCalledWith('EXISTING_ID', expect.anything(), expect.anything(), expect.anything(), false);
    expect(index.get('note.md')?.driveId).toBe('EXISTING_ID');
    expect(result.pushed).toEqual(['note.md']);
  });

  it('still uploads a genuinely new file when Drive has no same-name match', async () => {
    const vaultFiles = new Map([['fresh.md', makeFile('fresh.md', 'fresh.md')]]);
    const app = makeFakeApp(vaultFiles);

    const uploadFile = vi.fn().mockResolvedValue('BRAND_NEW_ID');
    const updateFile = vi.fn();
    const drive = {
      listChildren: vi.fn().mockResolvedValue([]),
      uploadFile,
      updateFile,
      pruneRevisions: vi.fn().mockResolvedValue(undefined),
    } as unknown as DriveApi;

    const index = new PathIndex(app, drive, 'ROOT_ID');
    const snapshot = new VaultSnapshot(app);
    const pendingOps: PendingOps = { 'fresh.md': 'create' };
    const settings = { ...DEFAULT_SETTINGS, keepRevisions: false, changesToken: 'tok' };

    const syncer = new Syncer(app, drive, index, snapshot, settings, pendingOps, () => {});
    await syncer.forcePush();

    expect(updateFile).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledWith('fresh.md', 'ROOT_ID', expect.anything(), expect.anything(), expect.anything(), false);
    expect(index.get('fresh.md')?.driveId).toBe('BRAND_NEW_ID');
  });
});
