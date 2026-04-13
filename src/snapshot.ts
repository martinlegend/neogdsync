/**
 * VaultSnapshot — records vault file stats after each sync.
 * Stored in data.json (via plugin.saveSettings/loadSettings), not in a separate file.
 * On startup, diff current vault against snapshot to detect offline changes.
 *
 * Key design decisions:
 * - load() is a no-op; data is injected via setRaw() from loadSettings()
 * - save() updates in-memory state; caller must saveSettings() to persist
 * - setRaw() purges .obsidian entries (they're not in vault.getFiles())
 */

import { App, TFile } from 'obsidian';
import { Snapshot, PendingOps } from './types';

export class VaultSnapshot {
  private snapshot: Snapshot = {};

  constructor(private app: App) {}

  /** Injected by plugin.loadSettings() — purges .obsidian entries defensively. */
  setRaw(data: Snapshot | undefined): void {
    const raw = data || {};
    // Purge any .obsidian entries that may have been saved in earlier versions
    for (const key of Object.keys(raw)) {
      if (key.startsWith('.obsidian')) delete (raw as Record<string, unknown>)[key];
    }
    this.snapshot = raw;
  }

  /** No-op: data is injected via setRaw() from loadSettings(). */
  async load(): Promise<void> {}

  /**
   * Rebuild snapshot from current vault state.
   * Updates in-memory snapshot only; caller must call saveSettings() to persist.
   */
  async save(exclude: (path: string) => boolean): Promise<void> {
    const fresh: Snapshot = {};
    const files = this.app.vault.getFiles();
    for (const f of files) {
      if (!exclude(f.path)) {
        fresh[f.path] = { mtime: f.stat.mtime, size: f.stat.size };
      }
    }
    this.snapshot = fresh;
  }

  /**
   * Diff current vault against last snapshot.
   * Returns ops that happened while plugin was offline.
   * Must be called after onLayoutReady so vault.getFiles() returns accurate stats.
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
      } else if ((f.stat.mtime - snap.mtime > 2000) || f.stat.size !== snap.size) {
        ops[f.path] = 'modify';
      }
    }

    // Deleted files — in snapshot but not in current vault
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

  getAll(): Snapshot {
    return this.snapshot;
  }
}
