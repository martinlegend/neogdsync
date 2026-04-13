/**
 * Snapshot — records vault state after each sync.
 * Stored in .neogdsync/snapshot.json, separate from data.json.
 * On startup, diff current vault against snapshot to catch offline changes.
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { Snapshot, PendingOps } from './types';

const SNAPSHOT_PATH = '.neogdsync/snapshot.json';

export class VaultSnapshot {
  private snapshot: Snapshot = {};

  constructor(private app: App) {}

  async load(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(normalizePath(SNAPSHOT_PATH));
      this.snapshot = JSON.parse(raw);
    } catch {
      this.snapshot = {};
    }
  }

  async save(exclude: (path: string) => boolean): Promise<void> {
    const fresh: Snapshot = {};
    const files = this.app.vault.getFiles();
    for (const f of files) {
      if (!exclude(f.path)) {
        fresh[f.path] = { mtime: f.stat.mtime, size: f.stat.size };
      }
    }
    this.snapshot = fresh;
    // Ensure .neogdsync/ directory exists before writing
    const dir = normalizePath('.neogdsync');
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(
      normalizePath(SNAPSHOT_PATH),
      JSON.stringify(fresh),
    );
  }

  /**
   * Diff current vault against last snapshot.
   * Returns ops that happened while plugin was offline.
   */
  computeDiff(exclude: (path: string) => boolean): PendingOps {
    const ops: PendingOps = {};
    const currentFiles = this.app.vault.getFiles();
    const currentPaths = new Set<string>();

    for (const f of currentFiles) {
      if (exclude(f.path)) continue;
      currentPaths.add(f.path);
      const snap = this.snapshot[f.path];
      if (!snap) {
        ops[f.path] = 'create';
      } else if (f.stat.mtime > snap.mtime || f.stat.size !== snap.size) {
        ops[f.path] = 'modify';
      }
    }

    // Deleted files
    for (const p of Object.keys(this.snapshot)) {
      if (!currentPaths.has(p)) {
        ops[p] = 'delete';
      }
    }

    return ops;
  }

  get(path: string) {
    return this.snapshot[path];
  }
}
