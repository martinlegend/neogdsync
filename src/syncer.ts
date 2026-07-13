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
        driveChanged.set(localPath, { removed: c.removed || c.file?.trashed === true, mtime: c.file?.modifiedTime });
      }
    }

    // Bug fix: resolve Drive changes whose fileId is not yet in the local index.
    // This happens when a device's index is stale (e.g. after reinstall or rebuild),
    // causing new files from other devices to be silently dropped every sync.
    const FOLDER_MIME = 'application/vnd.google-apps.folder';
    // Skip changes whose embedded file metadata already shows trashed=true. Without this,
    // a stale "modified" event from before the trash event would walk the unknown-changes
    // path below and resurrect the file locally even though Drive's current state is trashed.
    const unknownChanges = changes.filter(
      c => !driveIdToPath.has(c.fileId) && !c.removed && !(c.file?.trashed),
    );
    if (unknownChanges.length > 0) {
      // Build reverse map: driveId → localPath for all known folders (+ vault root)
      const folderIdToPath = new Map<string, string>();
      folderIdToPath.set(this.settings.vaultRootId, '');
      for (const p of this.index.allPaths()) {
        const e = this.index.get(p);
        if (e?.isFolder) folderIdToPath.set(e.driveId, p);
      }

      // Pass 1: register new folders into folderIdToPath so that files inside them
      // can be resolved in Pass 2. Without this, a file inside a newly-created folder
      // always fails with "parent folder not in index" because the folder change is
      // silently skipped before the file change is processed.
      for (const c of unknownChanges) {
        try {
          const meta = await this.drive.getFileMeta(c.fileId);
          if (meta.trashed || meta.mimeType !== FOLDER_MIME) continue;
          const parentId = meta.parents?.[0];
          if (!parentId) continue;
          const parentPath = folderIdToPath.get(parentId);
          if (parentPath === undefined) continue; // parent itself unknown; will warn in pass 2
          const folderLocalPath = parentPath ? `${parentPath}/${meta.name}` : meta.name;
          if (this.exclude(folderLocalPath)) continue;
          folderIdToPath.set(c.fileId, folderLocalPath);
          this.index.set(folderLocalPath, {
            driveId: c.fileId,
            driveMtime: meta.modifiedTime,
            syncedAt: 0,
            isFolder: true,
          });
        } catch (err: unknown) {
          console.warn(`[NeoGDSync] Could not resolve unknown folder ${c.fileId}:`,
            err instanceof Error ? err.message : String(err));
        }
      }

      // Pass 2: resolve files, now that new folders are in folderIdToPath
      for (const c of unknownChanges) {
        try {
          const meta = await this.drive.getFileMeta(c.fileId);
          // Defence-in-depth: even if the change event lacked `trashed`, the live metadata
          // may report it. Never resurrect a file that is currently in Drive trash.
          if (meta.trashed) continue;
          if (meta.mimeType === FOLDER_MIME) continue;
          const parentId = meta.parents?.[0];
          if (!parentId) {
            console.warn(`[NeoGDSync] Unknown fileId ${c.fileId} (${meta.name}) has no parent, skipping`);
            continue;
          }
          const folderPath = folderIdToPath.get(parentId);
          if (folderPath === undefined) {
            console.warn(`[NeoGDSync] Unknown fileId ${c.fileId} (${meta.name}): parent folder ${parentId} not in index — run Rebuild Index to repair`);
            continue;
          }
          const localPath = folderPath ? `${folderPath}/${meta.name}` : meta.name;
          if (this.exclude(localPath)) continue;
          // Pre-populate index so pullNewFromDrive can download this file
          this.index.set(localPath, {
            driveId: c.fileId,
            driveMtime: meta.modifiedTime,
            syncedAt: 0,
            isFolder: false,
          });
          driveIdToPath.set(c.fileId, localPath);
          driveChanged.set(localPath, { removed: false, mtime: meta.modifiedTime });
        } catch (err: unknown) {
          console.warn(`[NeoGDSync] Could not resolve unknown fileId ${c.fileId}:`,
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

    const handled = new Set([...result.pushed, ...result.pulled, ...result.deleted]);
    await this.pullNewFromDrive(driveChanged, result, handled);

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

  async forcePush(folderFilter?: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const prefix = folderFilter ? normFolder(folderFilter) : undefined;

    // Merge offline diff first so freshly-modified files aren't missed.
    const offlineDiff = this.snapshot.computeDiff(p => this.exclude(p));
    for (const [path, op] of Object.entries(offlineDiff)) {
      if (!this.pendingOps[path]) this.pendingOps[path] = op;
    }

    const allOps = Object.entries(this.pendingOps)
      .filter(([path]) => !prefix || matchesFolder(path, prefix));
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

  async forcePull(folderFilter?: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const prefix = folderFilter ? normFolder(folderFilter) : undefined;

    if (prefix) {
      this.onProgress(`Rebuilding index for ${prefix}…`);
      const found = await this.index.rebuildFolder(prefix, msg => this.onProgress(`Crawling: ${msg}`));
      if (!found) {
        result.errors.push({ path: prefix, error: `Folder not found on Drive: ${prefix}` });
        return result;
      }
    } else {
      this.onProgress('Rebuilding drive index…');
      await this.index.rebuild(msg => this.onProgress(`Crawling: ${msg}`));
    }

    const paths = this.index.allPaths()
      .filter(p => !prefix || matchesFolder(p, prefix));
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
    if (!file || !(file instanceof TFile)) {
      // Folder or missing file: clear the stuck op so it doesn't loop forever.
      // Folders are created on-demand by resolveParentFolder; missing files have nothing to push.
      result.pushed.push(path);
      return;
    }
    const bytes = await this.app.vault.readBinary(file);
    const mtime = new Date(file.stat.mtime).toISOString();
    const mimeType = mime.fromPath(path);
    const cached = this.index.get(path);
    if (cached && !cached.isFolder) {
      // Cross-folder rename: 'create' op + existing driveId means index.rename already ran.
      // Drive.updateFile only updates content — we must also move the file to the new parent.
      if (op === 'create') {
        const targetParentId = await this.index.resolveParentFolder(path);
        const meta = await this.drive.getFileMeta(cached.driveId);
        const currentParentId = meta.parents?.[0];
        if (currentParentId && currentParentId !== targetParentId) {
          await this.drive.moveFile(cached.driveId, currentParentId, targetParentId);
        }
      }
      await this.drive.updateFile(cached.driveId, bytes, mimeType, mtime, this.settings.keepRevisions);
      this.index.set(path, { ...cached, driveMtime: mtime, syncedAt: Date.now() });
      if (this.settings.keepRevisions) {
        const keepCount = mime.isBinaryMime(mimeType) ? this.settings.binaryRevisionKeepCount : this.settings.revisionKeepCount;
        // Best-effort: a prune failure shouldn't fail the sync that just succeeded.
        this.drive.pruneRevisions(cached.driveId, keepCount).catch(err =>
          console.warn(`[NeoGDSync] revision prune failed for ${path}:`, err));
      }
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
      try {
        await this.drive.deleteFile(cached.driveId);
        this.index.delete(path);
        result.deleted.push(path);
      } catch (err: unknown) {
        result.errors.push({ path, error: `Drive delete failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else {
      result.deleted.push(path);
    }
  }

  private async handleConflict(path: string, driveMtime: string, result: SyncResult): Promise<void> {
    const entry = this.index.get(path);
    if (!entry) return;

    // Bug fix: conflict direction was reversed — local was pushed to Drive, overwriting
    // the remote (newer) version. Correct behaviour: keep Drive version as authoritative,
    // save local offline edits as a .conflict copy for the user to review and merge.
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    const base = ext ? path.slice(0, -ext.length) : path;
    const conflictPath = `${base}.conflict${ext}`;

    // 1. Save local offline edits as the conflict copy
    const localFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
    const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
    if (localFile instanceof TFile) {
      const localBytes = await this.app.vault.readBinary(localFile);
      await writeLocal(this.app, conflictPath, localBytes);
    }

    // 2. Pull the Drive version as the canonical local file (no push to Drive)
    const driveBytes = await this.drive.downloadFile(entry.driveId);
    await writeLocal(this.app, path, driveBytes);
    this.index.set(path, { ...entry, driveMtime, syncedAt: Date.now() });

    result.conflicts.push({ localPath: path, localMtime, driveMtime, conflictCopyPath: conflictPath, detectedAt: Date.now() });
    result.pulled.push(path);
  }

  private async pullNewFromDrive(
    driveChanged: Map<string, { removed: boolean; mtime?: string }>,
    result: SyncResult,
    handled: Set<string>,
  ): Promise<void> {
    for (const [path, change] of driveChanged.entries()) {
      if (this.exclude(path)) continue;
      // Only skip paths successfully handled in the main loop; stale pendingOps that
      // returned early (missing local file, missing index entry) must not block pulls.
      if (handled.has(path)) continue;
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

// ── Folder filter helpers ──────────────────────────────────────

export function normFolder(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

export function matchesFolder(filePath: string, folder: string): boolean {
  return filePath === folder || filePath.startsWith(folder + '/');
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
