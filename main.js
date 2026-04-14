"use strict";
function matchGlob(pattern, path) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\x00").replace(/\*/g, "[^/]*").replace(/\x00/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp("^" + escaped + "$").test(path);
}
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => NeoGDSync
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/types.ts
var DEFAULT_SETTINGS = {
  refreshToken: "",
  vaultRootId: "",
  lastSyncedAt: 0,
  changesToken: "",
  syncMode: "smart",
  keepRevisions: true,
  excludePaths: [
    ".smart-env/**",
    ".smtcmp*",
    ".git/**",
    "**/.DS_Store",
    "**/node_modules/**",
    ".neogdsync/**"
  ],
  concurrency: 6
};

// src/auth.ts
var PROXY_URL = "https://ogd.richardxiong.com/api/access";
var cached = null;
async function getAccessToken(refreshToken) {
  if (cached && Date.now() < cached.expiresAt - 6e4) {
    return cached.token;
  }
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const { access_token, expires_in } = await resp.json();
  cached = { token: access_token, expiresAt: Date.now() + expires_in * 1e3 };
  return cached.token;
}
function clearTokenCache() {
  cached = null;
}

// src/driveApi.ts
var BASE = "https://www.googleapis.com/drive/v3";
var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
var FOLDER_MIME = "application/vnd.google-apps.folder";
async function req(method, url, body, headers, refreshToken) {
  const token = refreshToken ? await getAccessToken(refreshToken) : "";
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Drive ${method} ${url} \u2192 ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp;
}
var DriveApi = class {
  constructor(refreshToken) {
    this.refreshToken = refreshToken;
  }
  async fetch(method, url, body, headers) {
    return req(method, url, body, headers, this.refreshToken);
  }
  // ── Folder operations ──────────────────────────────────────────
  /** List direct children of a folder */
  async listChildren(folderId) {
    var _a;
    const results = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
        pageSize: "1000"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const resp = await this.fetch("GET", `${BASE}/files?${params}`);
      const data = await resp.json();
      results.push(...(_a = data.files) != null ? _a : []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return results;
  }
  /** Create a folder, return its Drive ID */
  async createFolder(name, parentId) {
    const resp = await this.fetch(
      "POST",
      `${BASE}/files?fields=id`,
      JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      { "Content-Type": "application/json" }
    );
    const { id } = await resp.json();
    return id;
  }
  // ── File operations ────────────────────────────────────────────
  /** Upload a new file (multipart). Returns Drive ID. */
  async uploadFile(name, parentId, content, mimeType, modifiedTime, keepRevision = false) {
    const boundary = "neogdsync_boundary";
    const meta = JSON.stringify({ name, parents: [parentId], modifiedTime });
    const body = buildMultipart(boundary, meta, content, mimeType);
    const params = new URLSearchParams({ uploadType: "multipart", fields: "id" });
    if (keepRevision) params.set("keepRevisionForever", "true");
    const resp = await this.fetch(
      "POST",
      `${UPLOAD}/files?${params}`,
      body,
      { "Content-Type": `multipart/related; boundary=${boundary}` }
    );
    const { id } = await resp.json();
    return id;
  }
  /** Update existing file content. Returns Drive ID (unchanged). */
  async updateFile(driveId, content, mimeType, modifiedTime, keepRevision = false) {
    const boundary = "neogdsync_boundary";
    const meta = JSON.stringify({ modifiedTime });
    const body = buildMultipart(boundary, meta, content, mimeType);
    const params = new URLSearchParams({ uploadType: "multipart", fields: "id" });
    if (keepRevision) params.set("keepRevisionForever", "true");
    const resp = await this.fetch(
      "PATCH",
      `${UPLOAD}/files/${driveId}?${params}`,
      body,
      { "Content-Type": `multipart/related; boundary=${boundary}` }
    );
    const { id } = await resp.json();
    return id;
  }
  /** Rename a file on Drive */
  async renameFile(driveId, newName) {
    await this.fetch(
      "PATCH",
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ name: newName }),
      { "Content-Type": "application/json" }
    );
  }
  /** Delete a file (move to trash) */
  async deleteFile(driveId) {
    await this.fetch("DELETE", `${BASE}/files/${driveId}`);
  }
  /** Download file content */
  async downloadFile(driveId) {
    const resp = await this.fetch("GET", `${BASE}/files/${driveId}?alt=media`);
    return resp.arrayBuffer();
  }
  /** Get file metadata */
  async getFileMeta(driveId) {
    const resp = await this.fetch("GET", `${BASE}/files/${driveId}?fields=id,name,mimeType,modifiedTime,parents,size`);
    return resp.json();
  }
  /** Get Drive changes since a token */
  async getChanges(pageToken) {
    var _a, _b;
    const changes = [];
    let token = pageToken;
    while (token) {
      const params = new URLSearchParams({
        pageToken: token,
        pageSize: "1000",
        includeRemoved: "true",
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime))"
      });
      const resp = await this.fetch("GET", `${BASE}/changes?${params}`);
      const data = await resp.json();
      changes.push(...(_a = data.changes) != null ? _a : []);
      token = (_b = data.nextPageToken) != null ? _b : "";
      if (data.newStartPageToken) {
        return { changes, newToken: data.newStartPageToken };
      }
    }
    return { changes, newToken: pageToken };
  }
  /** Get a fresh start page token */
  async getStartPageToken() {
    const resp = await this.fetch("GET", `${BASE}/changes/startPageToken`);
    const { startPageToken } = await resp.json();
    return startPageToken;
  }
  /** List revisions of a file */
  async listRevisions(driveId) {
    var _a;
    const resp = await this.fetch("GET", `${BASE}/files/${driveId}/revisions?fields=revisions(id,modifiedTime,size)`);
    const data = await resp.json();
    return (_a = data.revisions) != null ? _a : [];
  }
};
function buildMultipart(boundary, meta, content, mime) {
  const enc = new TextEncoder();
  const header = enc.encode(
    `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${meta}\r
--${boundary}\r
Content-Type: ${mime}\r
\r
`
  );
  const footer = enc.encode(`\r
--${boundary}--`);
  const body = new Uint8Array(header.byteLength + content.byteLength + footer.byteLength);
  body.set(header, 0);
  body.set(new Uint8Array(content), header.byteLength);
  body.set(footer, header.byteLength + content.byteLength);
  return body;
}

// src/pathIndex.ts
var import_obsidian = require("obsidian");
var INDEX_PATH = ".neogdsync/index.db";
var FOLDER_MIME2 = "application/vnd.google-apps.folder";
var PathIndex = class {
  constructor(app, drive, vaultRootId) {
    this.app = app;
    this.drive = drive;
    this.vaultRootId = vaultRootId;
    this.index = {};
    this.dirty = false;
  }
  // ── Persistence ────────────────────────────────────────────────
  async load() {
    try {
      const raw = await this.app.vault.adapter.read((0, import_obsidian.normalizePath)(INDEX_PATH));
      this.index = JSON.parse(raw);
    } catch (e) {
      this.index = {};
    }
  }
  async save() {
    if (!this.dirty) return;
    await ensureDir(this.app, ".neogdsync");
    await this.app.vault.adapter.write((0, import_obsidian.normalizePath)(INDEX_PATH), JSON.stringify(this.index, null, 2));
    this.dirty = false;
  }
  // ── Core lookups ───────────────────────────────────────────────
  get(localPath) {
    return this.index[localPath];
  }
  set(localPath, entry) {
    this.index[localPath] = entry;
    this.dirty = true;
  }
  delete(localPath) {
    if (this.index[localPath]) {
      delete this.index[localPath];
      this.dirty = true;
    }
  }
  rename(oldPath, newPath) {
    const entry = this.index[oldPath];
    if (entry) {
      this.index[newPath] = entry;
      delete this.index[oldPath];
      this.dirty = true;
    }
  }
  allPaths() {
    return Object.keys(this.index);
  }
  // ── Drive path navigation ──────────────────────────────────────
  /**
   * Resolve a local path to its Drive folder ID.
   * Creates folders on Drive if they don't exist yet.
   * Caches folder IDs in the index.
   */
  async resolveParentFolder(localPath) {
    const parts = localPath.split("/");
    if (parts.length === 1) return this.vaultRootId;
    const parentPath = parts.slice(0, -1).join("/");
    return this.resolveFolder(parentPath);
  }
  async resolveFolder(localPath) {
    const cached2 = this.index[localPath];
    if (cached2 == null ? void 0 : cached2.isFolder) return cached2.driveId;
    const parts = localPath.split("/");
    let currentId = this.vaultRootId;
    let builtPath = "";
    for (const part of parts) {
      builtPath = builtPath ? `${builtPath}/${part}` : part;
      const cachedPart = this.index[builtPath];
      if (cachedPart == null ? void 0 : cachedPart.isFolder) {
        currentId = cachedPart.driveId;
        continue;
      }
      const children = await this.drive.listChildren(currentId);
      const found = children.find((c) => c.name === part && c.mimeType === FOLDER_MIME2);
      if (found) {
        this.set(builtPath, {
          driveId: found.id,
          driveMtime: found.modifiedTime,
          syncedAt: Date.now(),
          isFolder: true
        });
        currentId = found.id;
      } else {
        const newId = await this.drive.createFolder(part, currentId);
        this.set(builtPath, {
          driveId: newId,
          driveMtime: (/* @__PURE__ */ new Date()).toISOString(),
          syncedAt: Date.now(),
          isFolder: true
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
  async findOnDrive(localPath) {
    const parts = localPath.split("/");
    const fileName = parts[parts.length - 1];
    try {
      const parentId = await this.resolveParentFolder(localPath);
      const children = await this.drive.listChildren(parentId);
      const cached2 = this.index[localPath];
      if (cached2 && !cached2.isFolder) {
        const match = children.find((c) => c.id === cached2.driveId);
        if (match) return match.id;
      }
      const matches = children.filter((c) => c.name === fileName && c.mimeType !== FOLDER_MIME2);
      if (!matches.length) return null;
      matches.sort((a, b) => a.modifiedTime > b.modifiedTime ? -1 : 1);
      return matches[0].id;
    } catch (e) {
      return null;
    }
  }
  /**
   * Rebuild the full index by crawling Drive from vaultRoot.
   * Used for initial setup or repair.
   */
  async rebuild(onProgress) {
    this.index = {};
    await this.crawl(this.vaultRootId, "", onProgress);
    this.dirty = true;
    await this.save();
  }
  async crawl(folderId, prefix, onProgress) {
    const children = await this.drive.listChildren(folderId);
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const isFolder = child.mimeType === FOLDER_MIME2;
      this.index[path] = {
        driveId: child.id,
        driveMtime: child.modifiedTime,
        syncedAt: Date.now(),
        isFolder
      };
      if (onProgress) onProgress(path);
      if (isFolder) {
        await this.crawl(child.id, path, onProgress);
      }
    }
  }
};
async function ensureDir(app, path) {
  const norm = (0, import_obsidian.normalizePath)(path);
  if (!(await app.vault.adapter.exists(norm))) {
    await app.vault.adapter.mkdir(norm);
  }
}

// src/snapshot.ts — snapshot lives in memory, persisted via plugin.saveSettings()
var import_obsidian2 = require("obsidian");
var VaultSnapshot = class {
  constructor(app) {
    this.app = app;
    this.snapshot = {};
  }
  // Called by plugin.loadSettings() to inject loaded snapshot
  setRaw(data) {
    const raw = data || {};
    // Purge any .obsidian entries that may have been saved in earlier versions
    for (const key of Object.keys(raw)) {
      if (key.startsWith(".obsidian")) delete raw[key];
    }
    this.snapshot = raw;
  }
  async load() {
    // no-op: data is injected via setRaw() from loadSettings()
  }
  async save(exclude) {
    const fresh = {};
    const files = this.app.vault.getFiles();
    for (const f of files) {
      if (!exclude(f.path)) {
        fresh[f.path] = { mtime: f.stat.mtime, size: f.stat.size };
      }
    }
    this.snapshot = fresh;
    // Snapshot will be persisted on next saveSettings() call (called by runSync)
  }
  /**
   * Diff current vault against last snapshot.
   * Returns ops that happened while plugin was offline.
   */
  computeDiff(exclude) {
    const ops = {};
    const currentFiles = this.app.vault.getFiles();
    const currentPaths = /* @__PURE__ */ new Set();
    for (const f of currentFiles) {
      if (exclude(f.path)) continue;
      currentPaths.add(f.path);
      const snap = this.snapshot[f.path];
      if (!snap) {
        ops[f.path] = "create";
      } else if ((f.stat.mtime - snap.mtime > 2000) || f.stat.size !== snap.size) {
        ops[f.path] = "modify";
      }
    }
    for (const p of Object.keys(this.snapshot)) {
      if (!currentPaths.has(p)) {
        ops[p] = "delete";
      }
    }
    return ops;
  }
  get(path) {
    return this.snapshot[path];
  }
  getAll() {
    return this.snapshot;
  }
};

// src/syncer.ts
var import_obsidian3 = require("obsidian");

// src/mime.ts
var MAP = {
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  ts: "application/typescript",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv"
};
function fromPath(path) {
  var _a, _b, _c;
  const ext = (_b = (_a = path.split(".").pop()) == null ? void 0 : _a.toLowerCase()) != null ? _b : "";
  return (_c = MAP[ext]) != null ? _c : "application/octet-stream";
}

// src/syncer.ts
var Syncer = class {
  constructor(app, drive, index, snapshot, settings, pendingOps, onProgress) {
    this.app = app;
    this.drive = drive;
    this.index = index;
    this.snapshot = snapshot;
    this.settings = settings;
    this.pendingOps = pendingOps;
    this.onProgress = onProgress;
    this.conflicts = [];
  }
  exclude(path) {
    if (path.startsWith(".neogdsync/")) return true;
    if (path.startsWith(".smart-env/")) return true;
    if (path.startsWith(".smtcmp")) return true;
    if (path.endsWith(".DS_Store")) return true;
    if (path.includes("node_modules/")) return true;
    if (path.startsWith(".git/")) return true;
    if (path === ".neogdsync") return true;
    for (const pat of this.settings.excludePaths) {
      if (matchGlob(pat, path)) return true;
    }
    return false;
  }
  // ── Smart Sync ─────────────────────────────────────────────────
  async smartSync() {
    var _a;
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    this.onProgress("Scanning local changes\u2026");
    const offlineDiff = this.snapshot.computeDiff((p) => this.exclude(p));
    for (const [path, op] of Object.entries(offlineDiff)) {
      if (!this.pendingOps[path]) {
        this.pendingOps[path] = op;
      }
    }
    this.onProgress("Fetching Drive changes\u2026");
    let changes = [], newToken = this.settings.changesToken;
    try {
      if (!this.settings.changesToken) {
        this.settings.changesToken = await this.drive.getStartPageToken();
      }
      const result = await this.drive.getChanges(this.settings.changesToken);
      changes = result.changes;
      newToken = result.newToken;
    } catch (fetchErr) {
      console.warn("[NeoGDSync] Could not fetch Drive changes (offline or API error), pushing local changes only:", fetchErr.message);
    }
    const driveChanged = /* @__PURE__ */ new Map();
    const driveIdToPath = /* @__PURE__ */ new Map();
    for (const p of this.index.allPaths()) {
      const e = this.index.get(p);
      if (e) driveIdToPath.set(e.driveId, p);
    }
    for (const c of changes) {
      const localPath = driveIdToPath.get(c.fileId);
      if (localPath) {
        driveChanged.set(localPath, {
          removed: c.removed,
          mtime: (_a = c.file) == null ? void 0 : _a.modifiedTime
        });
      }
    }
    const allOps = Object.entries(this.pendingOps);
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] ${op}: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === "delete") {
          await this.handleDelete(path, result);
        } else {
          const driveChange = driveChanged.get(path);
          const indexEntry = this.index.get(path);
          const isDriveNewer = driveChange && !driveChange.removed && driveChange.mtime && indexEntry && driveChange.mtime > indexEntry.driveMtime;
          if (isDriveNewer) {
            await this.handleConflict(path, driveChange.mtime, result);
          } else {
            await this.handlePush(path, op, result);
          }
        }
      } catch (e) {
        result.errors.push({ path, error: e.message });
      }
    }
    await this.pullNewFromDrive(driveChanged, result);
    this.settings.changesToken = newToken;
    this.settings.lastSyncedAt = Date.now();
    await this.snapshot.save((p) => this.exclude(p));
    await this.index.save();
    // Clear pushed, deleted, AND pulled — pulled files trigger handleModify via
    // vault.modifyBinary() which re-adds them to pendingOps; clear all after sync.
    for (const p of [...result.pushed, ...result.deleted, ...result.pulled]) {
      delete this.pendingOps[p];
    }
    return result;
  }
  // ── Force Push ─────────────────────────────────────────────────
  async forcePush() {
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const ops = this.pendingOps;
    const allOps = Object.entries(ops);
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] push: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === "delete") await this.handleDelete(path, result);
        else await this.handlePush(path, op, result);
      } catch (e) {
        result.errors.push({ path, error: e.message });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    if (!this.settings.changesToken) {
      this.settings.changesToken = await this.drive.getStartPageToken();
    }
    await this.snapshot.save((p) => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pushed, ...result.deleted, ...result.pulled]) {
      delete this.pendingOps[p];
    }
    return result;
  }
  // ── Force Pull ─────────────────────────────────────────────────
  async forcePull() {
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    this.onProgress("Rebuilding Drive index\u2026");
    await this.index.rebuild((msg) => this.onProgress(`Crawling: ${msg}`));
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
      } catch (e) {
        result.errors.push({ path, error: e.message });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    await this.snapshot.save((p) => this.exclude(p));
    await this.index.save();
    // Clear pulled files — writeLocal fires vault modify events which re-add them
    for (const p of [...result.pulled, ...result.deleted]) {
      delete this.pendingOps[p];
    }
    return result;
  }
  // ── Internal helpers ───────────────────────────────────────────
  async handlePush(path, op, result) {
    const file = this.app.vault.getAbstractFileByPath((0, import_obsidian3.normalizePath)(path));
    if (!file || !(file instanceof import_obsidian3.TFile)) return;
    const bytes = await this.app.vault.readBinary(file);
    const mtime = new Date(file.stat.mtime).toISOString();
    const mimeType = fromPath(path);
    const cached2 = this.index.get(path);
    if (cached2 && !cached2.isFolder) {
      // File exists in Drive index → update in place, never create duplicate
      await this.drive.updateFile(cached2.driveId, bytes, mimeType, mtime, this.settings.keepRevisions);
      this.index.set(path, { ...cached2, driveMtime: mtime, syncedAt: Date.now() });
    } else {
      const parentId = await this.index.resolveParentFolder(path);
      const driveId = await this.drive.uploadFile(
        file.name,
        parentId,
        bytes,
        mimeType,
        mtime,
        this.settings.keepRevisions
      );
      this.index.set(path, { driveId, driveMtime: mtime, syncedAt: Date.now(), isFolder: false });
    }
    result.pushed.push(path);
  }
  async handleDelete(path, result) {
    const cached2 = this.index.get(path);
    if (cached2) {
      try {
        await this.drive.deleteFile(cached2.driveId);
      } catch (e) {
      }
      this.index.delete(path);
    }
    result.deleted.push(path);
  }
  async handleConflict(path, driveMtime, result) {
    const entry = this.index.get(path);
    if (!entry) return;
    const bytes = await this.drive.downloadFile(entry.driveId);
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
    const base = ext ? path.slice(0, -ext.length) : path;
    const conflictPath = `${base}.conflict${ext}`;
    await writeLocal(this.app, conflictPath, bytes);
    const localFile = this.app.vault.getAbstractFileByPath((0, import_obsidian3.normalizePath)(path));
    const localMtime = localFile instanceof import_obsidian3.TFile ? localFile.stat.mtime : 0;
    result.conflicts.push({
      localPath: path,
      localMtime,
      driveMtime,
      conflictCopyPath: conflictPath,
      detectedAt: Date.now()
    });
    await this.handlePush(path, "modify", result);
  }
  async pullNewFromDrive(driveChanged, result) {
    for (const [path, change] of driveChanged.entries()) {
      if (this.exclude(path)) continue;
      if (this.pendingOps[path]) continue;
      if (change.removed) {
        const localFile = this.app.vault.getAbstractFileByPath((0, import_obsidian3.normalizePath)(path));
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
      } catch (e) {
        result.errors.push({ path, error: e.message });
      }
    }
  }
};
async function writeLocal(app, path, bytes) {
  const norm = (0, import_obsidian3.normalizePath)(path);
  const parts = path.split("/");
  if (parts.length > 1) {
    const dir = (0, import_obsidian3.normalizePath)(parts.slice(0, -1).join("/"));
    if (!await app.vault.adapter.exists(dir)) {
      await app.vault.adapter.mkdir(dir);
    }
  }
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof import_obsidian3.TFile) {
    await app.vault.modifyBinary(existing, bytes);
  } else {
    await app.vault.createBinary(norm, bytes);
  }
}

// src/main.ts
var NeoGDSync = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.pendingOps = {};
    this.conflicts = [];
    this.syncing = false;
  }
  // ── Lifecycle ──────────────────────────────────────────────────
  async onload() {
    this.snapshot = new VaultSnapshot(this.app);
    await this.loadSettings();
    this.drive = new DriveApi(this.settings.refreshToken);
    this.index = new PathIndex(this.app, this.drive, this.settings.vaultRootId);
    await this.index.load();
    // snapshot already loaded via setRaw() in loadSettings()
    // Delay BOTH offline diff AND event registration until layout is ready.
    // Before onLayoutReady, vault.getFiles() returns stale/incorrect stat values
    // (mtime/size), which causes computeDiff to falsely flag all files as changed.
    this.app.workspace.onLayoutReady(() => {
      const filesBefore = this.app.vault.getFiles().length;
      console.log(`[NeoGDSync] onLayoutReady: vault has ${filesBefore} files`);
      this.mergeOfflineDiff();
      this.registerEvents();
      console.log("[NeoGDSync] Vault events registered (layout ready)");
    });
    const ribbonIcon = this.addRibbonIcon("cloud", "NeoGDSync", () => this.openSyncModal());
    ribbonIcon.addClass("neogdsync-ribbon");
    this.statusEl = this.addStatusBarItem();
    this.updateStatus();
    this.addCommand({
      id: "smart-sync",
      name: "Smart Sync (auto conflict detect)",
      callback: () => this.runSync("smart")
    });
    this.addCommand({
      id: "force-push",
      name: "Force Push (local \u2192 Drive)",
      callback: () => this.runSync("push")
    });
    this.addCommand({
      id: "force-pull",
      name: "Force Pull (Drive \u2192 local)",
      callback: () => this.runSync("pull")
    });
    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild Drive index",
      callback: () => this.rebuildIndex()
    });
    this.addCommand({
      id: "show-conflicts",
      name: "Show conflicts",
      callback: () => this.showConflicts()
    });
    this.addSettingTab(new NeoSettingsTab(this.app, this));
    // ── URI handler: obsidian://neogdsync?mode=smart|push|pull
    this.registerObsidianProtocolHandler("neogdsync", (params) => {
      const mode = params.mode === "push" ? "push" : params.mode === "pull" ? "pull" : "smart";
      this.runSync(mode);
    });
    new import_obsidian4.Notice("NeoGDSync loaded \u2713");
  }
  async onunload() {
    // IMPORTANT: snapshot.save() MUST come before saveSettings()
    // so the fresh file stats are persisted to data.json
    await this.snapshot.save((p) => this.exclude(p));
    await this.saveSettings();
    await this.index.save();
  }
  // ── Vault events ───────────────────────────────────────────────
  registerEvents() {
    this.registerEvent(this.app.vault.on("create", (f) => this.handleCreate(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => this.handleModify(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.handleDelete(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => this.handleRename(f, old)));
  }
  exclude(path) {
    if (path.startsWith(".neogdsync")) return true;
    if (path.startsWith(".obsidian")) return true;
    if (path.startsWith(".smart-env")) return true;
    if (path.startsWith(".smtcmp")) return true;
    if (path.endsWith(".DS_Store")) return true;
    return false;
  }
  handleCreate(f) {
    if (this.syncing) return; // sync itself calls writeLocal which fires create events
    if (this.exclude(f.path)) return;
    if (!(f instanceof import_obsidian4.TFile)) return;  // skip folders
    const cur = this.pendingOps[f.path];
    if (cur === "delete") {
      this.pendingOps[f.path] = "modify";
    } else if (!cur) {
      this.pendingOps[f.path] = "create";
    }
    this.updateStatus();
    this.debouncedSave();
  }
  handleModify(f) {
    if (this.syncing) return; // sync itself calls writeLocal/modifyBinary which fires modify events
    if (this.exclude(f.path) || !(f instanceof import_obsidian4.TFile)) return;
    // Skip if file matches snapshot (Obsidian fires modify events on startup for all files)
    const snap = this.snapshot.get(f.path);
    if (snap && Math.abs(f.stat.mtime - snap.mtime) <= 2000 && f.stat.size === snap.size) return;
    if (!this.pendingOps[f.path]) {
      this.pendingOps[f.path] = "modify";
    }
    this.updateStatus();
    this.debouncedSave();
  }
  handleDelete(f) {
    if (this.exclude(f.path)) return;
    if (this.pendingOps[f.path] === "create") {
      delete this.pendingOps[f.path];
    } else {
      this.pendingOps[f.path] = "delete";
    }
    this.index.delete(f.path);
    this.updateStatus();
    this.debouncedSave();
  }
  handleRename(f, oldPath) {
    if (this.exclude(f.path) && this.exclude(oldPath)) return;
    if (this.pendingOps[oldPath] === "create") {
      delete this.pendingOps[oldPath];
      this.pendingOps[f.path] = "create";
    } else {
      this.pendingOps[oldPath] = "delete";
      this.pendingOps[f.path] = "create";
    }
    this.index.rename(oldPath, f.path);
    this.updateStatus();
    this.debouncedSave();
  }
  mergeOfflineDiff() {
    const snapData = this.snapshot.getAll ? this.snapshot.getAll() : {};
    const snapCount = Object.keys(snapData).length;
    const vaultCount = this.app.vault.getFiles().length;
    console.log(`[NeoGDSync] mergeOfflineDiff: snapshot=${snapCount} entries, vault=${vaultCount} files`);
    if (snapCount === 0) {
      // No snapshot yet — save current vault state as baseline, don't flood pendingOps
      console.log("[NeoGDSync] No snapshot found — saving current vault as baseline, skipping offline diff");
      this.snapshot.save((p) => this.exclude(p)).then(() => this.saveSettings()).catch(console.error);
      return;
    }
    const diff = this.snapshot.computeDiff((p) => this.exclude(p));
    const diffEntries = Object.entries(diff);
    console.log(`[NeoGDSync] computeDiff returned ${diffEntries.length} ops`);
    // Log sample of flagged files to understand why they're being flagged
    const sample = diffEntries.slice(0, 5);
    for (const [path, op] of sample) {
      const f = this.app.vault.getAbstractFileByPath(path);
      const snap = snapData[path];
      if (f && snap && f.stat) {
        console.log(`[NeoGDSync]   ${op}: ${path} | disk mtime=${f.stat.mtime} snap mtime=${snap.mtime} diff=${f.stat.mtime - snap.mtime}ms | disk size=${f.stat.size} snap size=${snap.size}`);
      } else {
        console.log(`[NeoGDSync]   ${op}: ${path} | f=${!!f} snap=${!!snap}`);
      }
    }
    let count = 0;
    for (const [path, op] of diffEntries) {
      if (!this.pendingOps[path]) {
        this.pendingOps[path] = op;
        count++;
      }
    }
    if (count > 0) {
      console.log(`[NeoGDSync] Startup diff: ${count} offline changes detected`);
    } else {
      console.log("[NeoGDSync] Startup diff: 0 offline changes — snapshot is current");
    }
  }
  // ── Sync ───────────────────────────────────────────────────────
  async runSync(mode) {
    if (this.syncing) {
      new import_obsidian4.Notice("Sync already in progress");
      return;
    }
    if (!this.settings.refreshToken) {
      new import_obsidian4.Notice("NeoGDSync: no refresh token configured");
      return;
    }
    this.syncing = true;
    this.updateStatus("Syncing\u2026");
    const notice = new import_obsidian4.Notice(`NeoGDSync: ${mode} sync started\u2026`, 0);
    try {
      const syncer = new Syncer(
        this.app,
        this.drive,
        this.index,
        this.snapshot,
        this.settings,
        this.pendingOps,
        (msg) => {
          notice.setMessage(`NeoGDSync: ${msg}`);
        }
      );
      let result;
      if (mode === "push") result = await syncer.forcePush();
      else if (mode === "pull") result = await syncer.forcePull();
      else result = await syncer.smartSync();
      this.conflicts.push(...result.conflicts);
      this.settings.lastSyncedAt = Date.now();
      await this.saveSettings();
      await this.index.save();
      const summary = `\u2191${result.pushed.length} \u2193${result.pulled.length} \u{1F5D1}${result.deleted.length}` + (result.conflicts.length ? ` \u26A0\uFE0F${result.conflicts.length} conflicts` : "") + (result.errors.length ? ` \u274C${result.errors.length} errors` : "");
      notice.setMessage(`NeoGDSync: done \u2014 ${summary}`);
      setTimeout(() => notice.hide(), 4e3);
      if (result.errors.length) {
        console.error("[NeoGDSync] Errors:", result.errors);
      }
      if (result.conflicts.length) {
        new import_obsidian4.Notice(`\u26A0\uFE0F ${result.conflicts.length} conflict(s) detected \u2014 check NeoGDSync conflicts`, 6e3);
      }
    } catch (e) {
      notice.setMessage(`NeoGDSync: ERROR \u2014 ${e.message}`);
      setTimeout(() => notice.hide(), 5e3);
      console.error("[NeoGDSync]", e);
      this.syncing = false;
      this.updateStatus();
    } finally {
      // Keep syncing=true for 600ms so vault events fired by writeLocal/modifyBinary
      // (which fire asynchronously after the awaits complete) are still suppressed by
      // handleModify/handleCreate. Then re-save snapshot with fresh TFile stats.
      setTimeout(() => {
        this.snapshot.save((p) => this.exclude(p))
          .then(() => this.saveSettings())
          .catch(console.error)
          .finally(() => {
            this.syncing = false;
            this.updateStatus();
          });
      }, 600);
    }
  }
  async rebuildIndex() {
    if (this.syncing) {
      new import_obsidian4.Notice("Sync in progress");
      return;
    }
    this.syncing = true;
    const notice = new import_obsidian4.Notice("NeoGDSync: rebuilding Drive index\u2026", 0);
    try {
      await this.index.rebuild((msg) => notice.setMessage(`NeoGDSync: ${msg}`));
      notice.setMessage("NeoGDSync: index rebuilt \u2713");
      setTimeout(() => notice.hide(), 3e3);
    } catch (e) {
      notice.setMessage(`NeoGDSync: rebuild failed \u2014 ${e.message}`);
      setTimeout(() => notice.hide(), 5e3);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }
  showConflicts() {
    new ConflictModal(this.app, this.conflicts).open();
  }
  openSyncModal() {
    new SyncModal(this.app, this).open();
  }
  // ── Status bar ─────────────────────────────────────────────────
  updateStatus(override) {
    if (!this.statusEl) return;
    if (override) {
      this.statusEl.setText(`\u2601 ${override}`);
      return;
    }
    const n = Object.keys(this.pendingOps).length;
    const c = this.conflicts.length;
    let txt = n > 0 ? `\u2601 ${n} pending` : "\u2601 synced";
    if (c > 0) txt += ` \u26A0\uFE0F${c}`;
    this.statusEl.setText(txt);
  }
  debouncedSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveSettings(), 500);
  }
  async loadSettings() {
    var _a, _b, _c;
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (_a = saved == null ? void 0 : saved.settings) != null ? _a : {});
    this.pendingOps = (_b = saved == null ? void 0 : saved.pendingOps) != null ? _b : {};
    this.conflicts = (_c = saved == null ? void 0 : saved.conflicts) != null ? _c : [];
    // Inject snapshot into VaultSnapshot instance
    if (this.snapshot) this.snapshot.setRaw(saved == null ? void 0 : saved.snapshot);
  }
  async saveSettings() {
    await this.saveData({
      settings: this.settings,
      pendingOps: this.pendingOps,
      conflicts: this.conflicts,
      snapshot: this.snapshot ? this.snapshot.getAll() : {}
    });
  }
};
var SyncModal = class extends import_obsidian4.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "NeoGDSync" });
    const pending = Object.keys(this.plugin.pendingOps).length;
    contentEl.createEl("p", { text: `Pending operations: ${pending}` });
    if (pending > 0) {
      const ul = contentEl.createEl("ul");
      for (const [p, op] of Object.entries(this.plugin.pendingOps).slice(0, 20)) {
        ul.createEl("li", { text: `${op}: ${p}` });
      }
      if (pending > 20) ul.createEl("li", { text: `\u2026 and ${pending - 20} more` });
    }
    const btnRow = contentEl.createDiv({ cls: "neogdsync-btn-row" });
    const smartBtn = btnRow.createEl("button", { text: "\u26A1 Smart Sync" });
    smartBtn.onclick = () => {
      this.close();
      this.plugin.runSync("smart");
    };
    const pushBtn = btnRow.createEl("button", { text: "\u2191 Force Push" });
    pushBtn.onclick = () => {
      this.close();
      this.plugin.runSync("push");
    };
    const pullBtn = btnRow.createEl("button", { text: "\u2193 Force Pull" });
    pullBtn.onclick = () => {
      this.close();
      this.plugin.runSync("pull");
    };
    if (this.plugin.conflicts.length > 0) {
      const conflictBtn = btnRow.createEl("button", { text: `\u26A0\uFE0F ${this.plugin.conflicts.length} Conflicts` });
      conflictBtn.onclick = () => {
        this.close();
        this.plugin.showConflicts();
      };
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ConflictModal = class extends import_obsidian4.Modal {
  constructor(app, conflicts) {
    super(app);
    this.conflicts = conflicts;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `Conflicts (${this.conflicts.length})` });
    if (!this.conflicts.length) {
      contentEl.createEl("p", { text: "No conflicts." });
      return;
    }
    for (const c of this.conflicts) {
      const div = contentEl.createDiv({ cls: "neogdsync-conflict" });
      div.createEl("strong", { text: c.localPath });
      div.createEl("br");
      div.createEl("small", {
        text: `Local: ${new Date(c.localMtime).toLocaleString()} | Drive: ${new Date(c.driveMtime).toLocaleString()}`
      });
      div.createEl("br");
      div.createEl("small", { text: `Drive copy saved as: ${c.conflictCopyPath}` });
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var NeoSettingsTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "NeoGDSync Settings" });
    new import_obsidian4.Setting(containerEl).setName("Refresh Token").setDesc("Google OAuth2 refresh token (from google-drive-sync plugin)").addText((t) => t.setPlaceholder("1//05o\u2026").setValue(this.plugin.settings.refreshToken).onChange(async (v) => {
      this.plugin.settings.refreshToken = v.trim();
      this.plugin.drive = new DriveApi(v.trim());
      clearTokenCache();
      await this.plugin.saveSettings();
    }));
    const vaultRootSetting = new import_obsidian4.Setting(containerEl).setName("Vault Root Folder ID").setDesc("Google Drive folder ID that is the root of this vault. Change requires plugin reload.");
    vaultRootSetting.addText((t) => {
      t.inputEl.style.width = "340px";
      t.inputEl.style.fontFamily = "monospace";
      t.setPlaceholder("1xGNFQGB\u2026").setValue(this.plugin.settings.vaultRootId).onChange(async (v) => {
        this.plugin.settings.vaultRootId = v.trim();
        this.plugin.index = new PathIndex(this.plugin.app, this.plugin.drive, v.trim());
        await this.plugin.index.load();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian4.Setting(containerEl).setName("Sync Mode").setDesc("Default sync mode when using ribbon icon").addDropdown((d) => d.addOption("smart", "Smart (conflict detect)").addOption("push", "Force Push").addOption("pull", "Force Pull").setValue(this.plugin.settings.syncMode).onChange(async (v) => {
      this.plugin.settings.syncMode = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian4.Setting(containerEl).setName("Keep Revisions").setDesc("Keep file revisions on Drive (version history)").addToggle((t) => t.setValue(this.plugin.settings.keepRevisions).onChange(async (v) => {
      this.plugin.settings.keepRevisions = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian4.Setting(containerEl).setName("Pending ops").setDesc(`${Object.keys(this.plugin.pendingOps).length} files queued`).addButton((b) => b.setButtonText("Clear all").onClick(async () => {
      this.plugin.pendingOps = {};
      await this.plugin.saveSettings();
      this.plugin.updateStatus();
      this.display();
    }));
    new import_obsidian4.Setting(containerEl).setName("Rebuild Drive Index").setDesc("Crawl Drive vault from root and rebuild local index.db").addButton((b) => b.setButtonText("Rebuild").onClick(() => this.plugin.rebuildIndex()));
    containerEl.createEl("h3", { text: "Status" });
    const stats = containerEl.createEl("p");
    stats.setText(
      `Last sync: ${this.plugin.settings.lastSyncedAt ? new Date(this.plugin.settings.lastSyncedAt).toLocaleString() : "never"} | Conflicts: ${this.plugin.conflicts.length}`
    );
  }
};
