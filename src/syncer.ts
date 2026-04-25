/**
 * Syncer — core sync engine.
 * Handles push, pull, smart sync, conflict detection.
 */

import { App, normalizePath, TFile } from 'obsidian';
import { DriveApi } from './driveApi';
import { PathIndex } from './pathIndex';
import { VaultSnapshot } from './snapshot';
import { NeoSettings, PendingOps, ConflictRecord, DriveChange } from './types';
import * as mime from './mime';

export interface SyncResult {
  pushed: string[];
  pulled: string[];
  deleted: string[];
  conflicts: ConflictRecord[];
  errors: Array<{ path: string; error: string }>;
}

export class Syncer {
  conflicts: ConflictRecord[] = [];

  constructor(
    private app: App,
    private drive: DriveApi,
    private index: PathIndex,
    private snapshot: VaultSnapshot,
    private settings: NeoSettings,
    private pendingOps: PendingOps,
    private onProgress: (msg: string) => void,
  ) {}

  private exclude(path: string): boolean {
    if (path.startsWith('.neogdsync/')) return true;
    if (path.startsWith('.smart-env/')) return true;
    if (path.startsWith('.smtcmp')) return true;
    if (path.endsWith('.DS_Store')) return true;
    if (path.includes('node_modules/')) return true;
    if (path.startsWith('.git/')) return true;
    if (path === '.neogdsync') return true;
    for (const pat of this.settings.excludePaths) {
      if (matchGlob(pat, path)) return true;
    }
    return false;
  }

  // ── Smart Sync ─────────────────────────────────────────────────

  async smartSync(): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };

    this.onProgress('Scanning local changes…');
    const offlineDiff = this.snapshot.computeDiff(p => this.exclude(p));
    for (const [path, op] of Object.entries(offlineDiff)) {
      if (!this.pendingOps[path]) this.pendingOps[path] = op;
    }

    this.onProgress('Fetching drive changes…');
    let changes: DriveChange[] = [];
    let newToken = this.settings.changesToken;
    try {
      if (!this.settings.changesToken) {
        this.settings.changesToken = await this.drive.getStartPageToken();
      }
      const r = await this.drive.getChanges(this.settings.changesToken);
      changes = r.changes;
      newToken = r.newToken;
    } catch (err: unknown) {
      console.warn('[NeoGDSync] Could not fetch Drive changes, pushing local changes only:',
        err instanceof Error ? err.message : String(err));
    }

    const driveChanged = new Map<string, { removed: boolean; mtime?: string }>();
    const driveIdToPath = new Map<string, string>();
    for (const p of this.index.allPaths()) {
      const e = this.index.get(p);
      if (e) driveIdToPath.set(e.driveId, p);
    }
    for (const c of changes) {
      const localPath = driveIdToPath.get(c.fileId);
      if (localPath) {
        driveChanged.set(localPath, { removed: c.removed, mtime: c.file?.modifiedTime });
      } else if (!c.removed) {
        // File exists on Drive but not in local index — resolve its path via API
        try {
          const meta = await this.drive.getFileMeta(c.fileId);
          if (meta.mimeType === 'application/vnd.google-apps.folder') continue;
          const parentId = meta.parents?.[0];
          let resolvedPath: string | null = null;
          if (parentId === this.settings.vaultRootId) {
            resolvedPath = meta.name;
          } else if (parentId) {
            const parentLocalPath = driveIdToPath.get(parentId);
            if (parentLocalPath) {
              resolvedPath = `${parentLocalPath}/${meta.name}`;
            }
          }
          if (resolvedPath) {
            this.index.set(resolvedPath, {
              driveId: c.fileId,
              driveMtime: meta.modifiedTime,
              syncedAt: Date.now(),
              isFolder: false,
            });
            driveIdToPath.set(c.fileId, resolvedPath);
            driveChanged.set(resolvedPath, { removed: false, mtime: meta.modifiedTime });
          } else {
            console.warn(`[NeoGDSync] Unknown Drive file ${c.fileId} ("${meta.name}"): parent ${parentId} not in index, skipping`);
          }
        } catch (err: unknown) {
          console.warn(`[NeoGDSync] Could not resolve unknown Drive file ${c.fileId}:`,
            err instanceof Error ? err.message : String(err));
        }
      }
    }

    const allOps = Object.entries(this.pendingOps);
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] ${op}: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === 'delete') {
          await this.handleDelete(path, result);
        } else {
          const driveChange = driveChanged.get(path);
          const indexEntry = this.index.get(path);
          const isDriveNewer = driveChange
            && !driveChange.removed
            && driveChange.mtime
            && indexEntry
            && driveChange.mtime > indexEntry.driveMtime;
          if (isDriveNewer) {
            await this.handleConflict(path, driveChange.mtime as string, result);
          } else {
            await this.handlePush(path, op, result);
          }
        }
      } catch (err: unknown) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await this.pullNewFromDrive(driveChanged, result);

    this.settings.changesToken = newToken;
    this.settings.lastSyncedAt = Date.now();
    this.snapshot.save(p => this.exclude(p));
    await this.index.save();

    for (const p of [...result.pushed, ...result.deleted, ...result.pulled]) {
      delete this.pendingOps[p];
    }
    return result;
  }

  // ── Force Push ─────────────────────────────────────────────────

  async forcePush(): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const allOps = Object.entries(this.pendingOps);
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] push: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === 'delete') await this.handleDelete(path, result);
        else await this.handlePush(path, op, result);
      } catch (err: unknown) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    if (!this.settings.changesToken) {
      this.settings.changesToken = await this.drive.getStartPageToken();
    }
    this.snapshot.save(p => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pushed, ...result.deleted, ...result.pulled]) {
      delete this.pendingOps[p];
    }
    return result;
  }

  // ── Force Pull ─────────────────────────────────────────────────

  async forcePull(): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    this.onProgress('Rebuilding drive index…');
    await this.index.rebuild(msg => this.onProgress(`Crawling: ${msg}`));
    const paths = this.index.allPaths();
    let done = 0;
    for (const path of paths) {
      const entry = this.index.get(path);
      if (!entry || entry.isFolder) continue;
      this.onProgress(`[${++done}] pull: ${path}`);
      try {
        const bytes = await this.drive.downloadFile(entry.driveId);
        await writeLocal(this.app, path, bytes);
        result.pulled.push(path);
      } catch (err: unknown) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    this.snapshot.save(p => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pulled, ...result.deleted]) {
      delete this.pendingOps[p];
    }
    return result;
  }

  // ── Internal helpers ───────────────────────────────────────────

  private async handlePush(path: string, op: 'create' | 'modify', result: SyncResult): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) return;
    const bytes = await this.app.vault.readBinary(file);
    const mtime = new Date(file.stat.mtime).toISOString();
    const mimeType = mime.fromPath(path);
    const cached = this.index.get(path);
    if (cached && !cached.isFolder) {
      await this.drive.updateFile(cached.driveId, bytes, mimeType, mtime, this.settings.keepRevisions);
      this.index.set(path, { ...cached, driveMtime: mtime, syncedAt: Date.now() });
    } else {
      const parentId = await this.index.resolveParentFolder(path);
      const driveId = await this.drive.uploadFile(
        file.name, parentId, bytes, mimeType, mtime, this.settings.keepRevisions,
      );
      this.index.set(path, { driveId, driveMtime: mtime, syncedAt: Date.now(), isFolder: false });
    }
    result.pushed.push(path);
  }

  private async handleDelete(path: string, result: SyncResult): Promise<void> {
    const cached = this.index.get(path);
    if (cached) {
      try { await this.drive.deleteFile(cached.driveId); } catch { /* already gone */ }
      this.index.delete(path);
    }
    result.deleted.push(path);
  }

  private async handleConflict(path: string, driveMtime: string, result: SyncResult): Promise<void> {
    const entry = this.index.get(path);
    if (!entry) return;

    // Save local version as a conflict copy so the user can manually merge
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    const base = ext ? path.slice(0, -ext.length) : path;
    const conflictPath = `${base}.conflict${ext}`;
    const localFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
    const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
    if (localFile instanceof TFile) {
      const localBytes = await this.app.vault.readBinary(localFile);
      await writeLocal(this.app, conflictPath, localBytes);
    }

    // Drive version is authoritative — pull it to the canonical path
    const driveBytes = await this.drive.downloadFile(entry.driveId);
    await writeLocal(this.app, path, driveBytes);
    this.index.set(path, { ...entry, driveMtime, syncedAt: Date.now() });

    result.conflicts.push({ localPath: path, localMtime, driveMtime, conflictCopyPath: conflictPath, detectedAt: Date.now() });
    result.pulled.push(path);
  }

  private async pullNewFromDrive(
    driveChanged: Map<string, { removed: boolean; mtime?: string }>,
    result: SyncResult,
  ): Promise<void> {
    for (const [path, change] of driveChanged.entries()) {
      if (this.exclude(path)) continue;
      if (this.pendingOps[path]) continue;
      if (change.removed) {
        const localFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (localFile) {
          await this.app.vault.trash(localFile, true);
          this.index.delete(path);
          result.deleted.push(path);
        }
        continue;
      }
      const entry = this.index.get(path);
      if (!entry || entry.isFolder) continue;
      try {
        const bytes = await this.drive.downloadFile(entry.driveId);
        await writeLocal(this.app, path, bytes);
        if (change.mtime) {
          this.index.set(path, { ...entry, driveMtime: change.mtime, syncedAt: Date.now() });
        }
        result.pulled.push(path);
      } catch (err: unknown) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

// ── Local file write ───────────────────────────────────────────

async function writeLocal(app: App, path: string, bytes: ArrayBuffer): Promise<void> {
  const norm = normalizePath(path);
  const parts = path.split('/');
  if (parts.length > 1) {
    const dir = normalizePath(parts.slice(0, -1).join('/'));
    if (!(await app.vault.adapter.exists(dir))) {
      await app.vault.adapter.mkdir(dir);
    }
  }
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, bytes);
  } else {
    await app.vault.createBinary(norm, bytes);
  }
}

// ── Glob matching ──────────────────────────────────────────────

function matchGlob(pattern: string, path: string): boolean {
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
