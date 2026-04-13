/**
 * Syncer — core sync engine.
 * Handles push, pull, smart sync, conflict detection.
 */

import { App, normalizePath, TFile, Notice } from 'obsidian';
import { DriveApi } from './driveApi';
import { PathIndex } from './pathIndex';
import { VaultSnapshot } from './snapshot';
import { NeoSettings, PendingOps, ConflictRecord } from './types';
import * as mime from './mime';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

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
    // User-defined excludes
    for (const pat of this.settings.excludePaths) {
      if (matchGlob(pat, path)) return true;
    }
    return false;
  }

  // ── Smart Sync ─────────────────────────────────────────────────

  async smartSync(): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };

    // Step 1: merge offline diff into pendingOps
    this.onProgress('Scanning local changes…');
    const offlineDiff = this.snapshot.computeDiff(p => this.exclude(p));
    for (const [path, op] of Object.entries(offlineDiff)) {
      if (!this.pendingOps[path]) {
        this.pendingOps[path] = op;
      }
    }

    // Step 2: fetch Drive changes since last sync (graceful — push-only if offline)
    this.onProgress('Fetching Drive changes…');
    let changes: any[] = [];
    let newToken = this.settings.changesToken;
    try {
      if (!this.settings.changesToken) {
        this.settings.changesToken = await this.drive.getStartPageToken();
      }
      const result = await this.drive.getChanges(this.settings.changesToken);
      changes = result.changes;
      newToken = result.newToken;
    } catch (fetchErr: any) {
      console.warn('[NeoGDSync] Could not fetch Drive changes (offline or API error), pushing local changes only:', fetchErr.message);
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
        driveChanged.set(localPath, {
          removed: c.removed,
          mtime: c.file?.modifiedTime,
        });
      }
    }

    // Step 3: process pending ops (push direction)
    const allOps = Object.entries(this.pendingOps);
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] ${op}: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === 'delete') {
          await this.handleDelete(path, result);
        } else {
          // Real conflict = Drive mtime is NEWER than what we last recorded in the index
          // This is token-independent and avoids false conflicts from stale changesTokens
          const driveChange = driveChanged.get(path);
          const indexEntry = this.index.get(path);
          const isDriveNewer = driveChange
            && !driveChange.removed
            && driveChange.mtime
            && indexEntry
            && driveChange.mtime > indexEntry.driveMtime;
          if (isDriveNewer) {
            await this.handleConflict(path, driveChange.mtime, result);
          } else {
            await this.handlePush(path, op, result);
          }
        }
      } catch (e: any) {
        result.errors.push({ path, error: e.message });
      }
    }

    // Step 4: pull new files from Drive (files on Drive not in local ops, newer than lastSyncedAt)
    await this.pullNewFromDrive(driveChanged, result);

    // Step 5: update token and snapshot
    this.settings.changesToken = newToken;
    this.settings.lastSyncedAt = Date.now();
    await this.snapshot.save(p => this.exclude(p));
    await this.index.save();

    // Clear pushed/deleted ops
    for (const p of [...result.pushed, ...result.deleted]) {
      delete this.pendingOps[p];
    }

    return result;
  }

  // ── Force Push ─────────────────────────────────────────────────

  async forcePush(): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const ops = this.pendingOps;
    const allOps = Object.entries(ops);
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] push: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === 'delete') await this.handleDelete(path, result);
        else await this.handlePush(path, op, result);
      } catch (e: any) {
        result.errors.push({ path, error: e.message });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    // Initialize changesToken after first push so smart sync can track Drive changes going forward
    if (!this.settings.changesToken) {
      this.settings.changesToken = await this.drive.getStartPageToken();
    }
    await this.snapshot.save(p => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pushed, ...result.deleted]) {
      delete this.pendingOps[p];
    }
    return result;
  }

  // ── Force Pull ─────────────────────────────────────────────────

  async forcePull(): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    this.onProgress('Rebuilding Drive index…');
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
      } catch (e: any) {
        result.errors.push({ path, error: e.message });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    await this.snapshot.save(p => this.exclude(p));
    await this.index.save();
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
      // File already exists on Drive — update in place, never create duplicate
      await this.drive.updateFile(cached.driveId, bytes, mimeType, mtime, this.settings.keepRevisions);
      this.index.set(path, { ...cached, driveMtime: mtime, syncedAt: Date.now() });
    } else {
      // File not in index → truly new, upload
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
    // Pull Drive version as .conflict copy, keep local as-is
    const entry = this.index.get(path);
    if (!entry) return;
    const bytes = await this.drive.downloadFile(entry.driveId);
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    const base = ext ? path.slice(0, -ext.length) : path;
    const conflictPath = `${base}.conflict${ext}`;
    await writeLocal(this.app, conflictPath, bytes);
    const localFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
    const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
    result.conflicts.push({
      localPath: path,
      localMtime,
      driveMtime,
      conflictCopyPath: conflictPath,
      detectedAt: Date.now(),
    });
    // Still push local version
    await this.handlePush(path, 'modify', result);
  }

  private async pullNewFromDrive(
    driveChanged: Map<string, { removed: boolean; mtime?: string }>,
    result: SyncResult,
  ): Promise<void> {
    // Find Drive-changed files not in local pendingOps
    for (const [path, change] of driveChanged.entries()) {
      if (this.exclude(path)) continue;
      if (this.pendingOps[path]) continue; // handled in push phase
      if (change.removed) {
        // Drive deleted something local
        const localFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (localFile) {
          await this.app.vault.trash(localFile, true);
          this.index.delete(path);
          result.deleted.push(path);
        }
        continue;
      }
      // Download updated file
      const entry = this.index.get(path);
      if (!entry || entry.isFolder) continue;
      try {
        const bytes = await this.drive.downloadFile(entry.driveId);
        await writeLocal(this.app, path, bytes);
        if (change.mtime) {
          this.index.set(path, { ...entry, driveMtime: change.mtime, syncedAt: Date.now() });
        }
        result.pulled.push(path);
      } catch (e: any) {
        result.errors.push({ path, error: e.message });
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
      await app.vault.createFolder(dir);
    }
  }
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, bytes);
  } else {
    await app.vault.createBinary(norm, bytes);
  }
}
