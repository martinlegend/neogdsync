/**
 * PathIndex — lightweight localPath→driveId cache.
 * Stored in .neogdsync/index.db (JSON), separate from data.json.
 * On cache miss, navigates Drive by path hierarchy from vaultRootId.
 */

import { DriveApi } from './driveApi';
import { FileIndex, IndexEntry } from './types';
import { App, normalizePath } from 'obsidian';

const INDEX_PATH = '.neogdsync/index.db';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class PathIndex {
  private index: FileIndex = {};
  private dirty = false;

  constructor(
    private app: App,
    private drive: DriveApi,
    private vaultRootId: string,
  ) {}

  // ── Persistence ────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(normalizePath(INDEX_PATH));
      this.index = JSON.parse(raw);
    } catch {
      this.index = {};
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await ensureDir(this.app, '.neogdsync');
    await this.app.vault.adapter.write(normalizePath(INDEX_PATH), JSON.stringify(this.index, null, 2));
    this.dirty = false;
  }

  // ── Core lookups ───────────────────────────────────────────────

  get(localPath: string): IndexEntry | undefined {
    return this.index[localPath];
  }

  set(localPath: string, entry: IndexEntry): void {
    this.index[localPath] = entry;
    this.dirty = true;
  }

  delete(localPath: string): void {
    if (this.index[localPath]) {
      delete this.index[localPath];
      this.dirty = true;
    }
  }

  rename(oldPath: string, newPath: string): void {
    const entry = this.index[oldPath];
    if (entry) {
      this.index[newPath] = entry;
      delete this.index[oldPath];
      this.dirty = true;
    }
  }

  allPaths(): string[] {
    return Object.keys(this.index);
  }

  // ── Drive path navigation ──────────────────────────────────────

  /**
   * Resolve a local path to its Drive folder ID.
   * Creates folders on Drive if they don't exist yet.
   * Caches folder IDs in the index.
   */
  async resolveParentFolder(localPath: string): Promise<string> {
    const parts = localPath.split('/');
    if (parts.length === 1) return this.vaultRootId;
    const parentPath = parts.slice(0, -1).join('/');
    return this.resolveFolder(parentPath);
  }

  async resolveFolder(localPath: string): Promise<string> {
    const cached = this.index[localPath];
    if (cached?.isFolder) return cached.driveId;

    const parts = localPath.split('/');
    let currentId = this.vaultRootId;
    let builtPath = '';

    for (const part of parts) {
      builtPath = builtPath ? `${builtPath}/${part}` : part;
      const cachedPart = this.index[builtPath];
      if (cachedPart?.isFolder) {
        currentId = cachedPart.driveId;
        continue;
      }
      // Look for folder among children of current
      const children = await this.drive.listChildren(currentId);
      const found = children.find(c => c.name === part && c.mimeType === FOLDER_MIME);
      if (found) {
        this.set(builtPath, {
          driveId: found.id,
          driveMtime: found.modifiedTime,
          syncedAt: Date.now(),
          isFolder: true,
        });
        currentId = found.id;
      } else {
        // Create the folder
        const newId = await this.drive.createFolder(part, currentId);
        this.set(builtPath, {
          driveId: newId,
          driveMtime: new Date().toISOString(),
          syncedAt: Date.now(),
          isFolder: true,
        });
        currentId = newId;
      }
    }
    return currentId;
  }

  /**
   * Find a file on Drive by navigating from vaultRoot by path.
   * Returns null if not found.
   */
  async findOnDrive(localPath: string): Promise<string | null> {
    const parts = localPath.split('/');
    const fileName = parts[parts.length - 1];
    try {
      const parentId = await this.resolveParentFolder(localPath);
      const children = await this.drive.listChildren(parentId);
      // Prefer index-known ID to avoid duplicates
      const cached = this.index[localPath];
      if (cached && !cached.isFolder) {
        const match = children.find(c => c.id === cached.driveId);
        if (match) return match.id;
      }
      // Fall back to name match (pick most recently modified if duplicates)
      const matches = children.filter(c => c.name === fileName && c.mimeType !== FOLDER_MIME);
      if (!matches.length) return null;
      matches.sort((a, b) => (a.modifiedTime > b.modifiedTime ? -1 : 1));
      return matches[0].id;
    } catch {
      return null;
    }
  }

  /**
   * Rebuild the full index by crawling Drive from vaultRoot.
   * Used for initial setup or repair.
   */
  async rebuild(onProgress?: (msg: string) => void): Promise<void> {
    this.index = {};
    await this.crawl(this.vaultRootId, '', onProgress);
    this.dirty = true;
    await this.save();
  }

  /**
   * Partial rebuild: re-crawl one folder subtree on Drive without touching the rest of the index.
   * Stale entries under the prefix are removed; entries outside are untouched.
   * Returns false if the Drive folder cannot be located (no creation attempted).
   */
  async rebuildFolder(folderPath: string, onProgress?: (msg: string) => void): Promise<boolean> {
    // Resolve Drive folder ID — prefer index, then navigate read-only.
    const cached = this.index[folderPath];
    let folderId: string | null = cached?.isFolder ? cached.driveId : null;
    if (!folderId) {
      folderId = await this.lookupFolderOnDrive(folderPath);
      if (!folderId) return false;
      this.set(folderPath, { driveId: folderId, driveMtime: new Date().toISOString(), syncedAt: Date.now(), isFolder: true });
    }

    // Remove stale file entries under this prefix (keep the folder entry itself).
    const prefix = folderPath + '/';
    for (const key of Object.keys(this.index)) {
      if (key.startsWith(prefix)) {
        delete this.index[key];
        this.dirty = true;
      }
    }

    await this.crawl(folderId, folderPath, onProgress);
    this.dirty = true;
    await this.save();
    return true;
  }

  /** Navigate to a folder read-only (no creation). Returns Drive folder ID or null. */
  private async lookupFolderOnDrive(localPath: string): Promise<string | null> {
    const parts = localPath.split('/');
    let currentId = this.vaultRootId;
    let builtPath = '';
    for (const part of parts) {
      builtPath = builtPath ? `${builtPath}/${part}` : part;
      const cached = this.index[builtPath];
      if (cached?.isFolder) { currentId = cached.driveId; continue; }
      const children = await this.drive.listChildren(currentId);
      const found = children.find(c => c.name === part && c.mimeType === FOLDER_MIME);
      if (!found) return null;
      currentId = found.id;
    }
    return currentId;
  }

  private async crawl(folderId: string, prefix: string, onProgress?: (msg: string) => void): Promise<void> {
    const children = await this.drive.listChildren(folderId);
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const isFolder = child.mimeType === FOLDER_MIME;
      this.index[path] = {
        driveId: child.id,
        driveMtime: child.modifiedTime,
        syncedAt: Date.now(),
        isFolder,
      };
      if (onProgress) onProgress(path);
      if (isFolder) {
        await this.crawl(child.id, path, onProgress);
      }
    }
  }
}

// ── helpers ────────────────────────────────────────────────────

async function ensureDir(app: App, path: string): Promise<void> {
  const norm = normalizePath(path);
  if (!(await app.vault.adapter.exists(norm))) {
    await app.vault.adapter.mkdir(norm);
  }
}
