/**
 * VaultSnapshot — records vault file stats after each sync.
 * Stored in data.json (via plugin.saveSettings/loadSettings), not in a separate file.
 * On startup, diff current vault against snapshot to detect offline changes.
 *
 * Key design decisions:
 * - load() is a no-op; data is injected via setRaw() from loadSettings()
 * - save() updates in-memory state only; caller must saveSettings() to persist
 * - setRaw() purges configDir entries (they're not in vault.getFiles())
 */

import { App } from 'obsidian';
import { Snapshot, PendingOps } from './types';

export class VaultSnapshot {
  private snapshot: Snapshot = {};

  constructor(private app: App) {}

  /** Injected by plugin.loadSettings() — purges config dir entries defensively. */
  setRaw(data: Snapshot | undefined): void {
    const raw = data || {};
    const configDir = this.app.vault.configDir;
    for (const key of Object.keys(raw)) {
      if (key.startsWith(configDir)) delete (raw as Record<string, unknown>)[key];
    }
    this.snapshot = raw;
  }

  /** No-op: data is injected via setRaw() from loadSettings(). */
  load(): void {}

  /**
   * Rebuild snapshot from current vault state.
   * Updates in-memory snapshot only; caller must call saveSettings() to persist.
   */
  save(exclude: (path: string) => boolean): void {
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

    for (const p of Object.keys(this.snapshot)) {
      // Skip excluded entries: a path that is now excluded (e.g. after the user
      // added a pattern) merely stops being tracked — it was not deleted.
      if (!currentPaths.has(p) && !exclude(p)) {
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
