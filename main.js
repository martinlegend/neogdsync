"use strict";
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
var import_obsidian5 = require("obsidian");

// src/types.ts
var DEFAULT_SETTINGS = {
  refreshToken: "",
  vaultRootId: "",
  authProxyUrl: "https://neogdsync-worker.neogdsync.workers.dev",
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

// src/driveApi.ts
var import_obsidian2 = require("obsidian");

// src/auth.ts
var import_obsidian = require("obsidian");
var DEFAULT_PROXY_URL = "https://neogdsync-worker.neogdsync.workers.dev";
var cached = null;
async function getAccessToken(refreshToken, proxyUrl = DEFAULT_PROXY_URL) {
  if (cached && Date.now() < cached.expiresAt - 6e4) {
    return cached.token;
  }
  const resp = await (0, import_obsidian.requestUrl)({
    url: proxyUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    throw: false
  });
  if (resp.status >= 400) throw new Error(`Auth failed: ${resp.status}`);
  const { access_token, expires_in } = resp.json;
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
async function driveRequest(method, url, body, headers, refreshToken, proxyUrl) {
  const token = refreshToken ? await getAccessToken(refreshToken, proxyUrl) : "";
  const resp = await (0, import_obsidian2.requestUrl)({
    url,
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    throw: false
  });
  if (resp.status >= 400) {
    const txt = resp.text.slice(0, 200);
    throw new Error(`Drive ${method} ${url} \u2192 ${resp.status}: ${txt}`);
  }
  return resp;
}
var DriveApi = class {
  constructor(refreshToken, proxyUrl) {
    this.refreshToken = refreshToken;
    this.proxyUrl = proxyUrl;
  }
  request(method, url, body, headers) {
    return driveRequest(method, url, body, headers, this.refreshToken, this.proxyUrl);
  }
  // ── Folder operations ──────────────────────────────────────────
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
      const resp = await this.request("GET", `${BASE}/files?${params}`);
      const data = resp.json;
      results.push(...(_a = data.files) != null ? _a : []);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return results;
  }
  async createFolder(name, parentId) {
    const resp = await this.request(
      "POST",
      `${BASE}/files?fields=id`,
      JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      { "Content-Type": "application/json" }
    );
    const { id } = resp.json;
    return id;
  }
  // ── File operations ────────────────────────────────────────────
  async uploadFile(name, parentId, content, mimeType, modifiedTime, keepRevision = false) {
    const boundary = "neogdsync_boundary";
    const meta = JSON.stringify({ name, parents: [parentId], modifiedTime });
    const body = buildMultipart(boundary, meta, content, mimeType);
    const params = new URLSearchParams({ uploadType: "multipart", fields: "id" });
    if (keepRevision) params.set("keepRevisionForever", "true");
    const resp = await this.request(
      "POST",
      `${UPLOAD}/files?${params}`,
      body.buffer,
      { "Content-Type": `multipart/related; boundary=${boundary}` }
    );
    const { id } = resp.json;
    return id;
  }
  async updateFile(driveId, content, mimeType, modifiedTime, keepRevision = false) {
    const boundary = "neogdsync_boundary";
    const meta = JSON.stringify({ modifiedTime });
    const body = buildMultipart(boundary, meta, content, mimeType);
    const params = new URLSearchParams({ uploadType: "multipart", fields: "id" });
    if (keepRevision) params.set("keepRevisionForever", "true");
    const resp = await this.request(
      "PATCH",
      `${UPLOAD}/files/${driveId}?${params}`,
      body.buffer,
      { "Content-Type": `multipart/related; boundary=${boundary}` }
    );
    const { id } = resp.json;
    return id;
  }
  async moveFile(driveId, oldParentId, newParentId) {
    const params = new URLSearchParams({ addParents: newParentId, removeParents: oldParentId, fields: "id" });
    await this.request("PATCH", `${BASE}/files/${driveId}?${params}`);
  }
  async renameFile(driveId, newName) {
    await this.request(
      "PATCH",
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ name: newName }),
      { "Content-Type": "application/json" }
    );
  }
  async deleteFile(driveId) {
    await this.request(
      "PATCH",
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ trashed: true }),
      { "Content-Type": "application/json" }
    );
  }
  async downloadFile(driveId) {
    const resp = await this.request("GET", `${BASE}/files/${driveId}?alt=media`);
    return resp.arrayBuffer;
  }
  async getFileMeta(driveId) {
    const resp = await this.request("GET", `${BASE}/files/${driveId}?fields=id,name,mimeType,modifiedTime,parents,size,trashed`);
    return resp.json;
  }
  async getChanges(pageToken) {
    var _a, _b;
    const changes = [];
    let token = pageToken;
    while (token) {
      const params = new URLSearchParams({
        pageToken: token,
        pageSize: "1000",
        includeRemoved: "true",
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,trashed))"
      });
      const resp = await this.request("GET", `${BASE}/changes?${params}`);
      const data = resp.json;
      changes.push(...(_a = data.changes) != null ? _a : []);
      token = (_b = data.nextPageToken) != null ? _b : "";
      if (data.newStartPageToken) {
        return { changes, newToken: data.newStartPageToken };
      }
    }
    return { changes, newToken: pageToken };
  }
  async getStartPageToken() {
    const resp = await this.request("GET", `${BASE}/changes/startPageToken`);
    const { startPageToken } = resp.json;
    return startPageToken;
  }
  async listRevisions(driveId) {
    var _a;
    const resp = await this.request("GET", `${BASE}/files/${driveId}/revisions?fields=revisions(id,modifiedTime,size)`);
    const data = resp.json;
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
var import_obsidian3 = require("obsidian");
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
      const raw = await this.app.vault.adapter.read((0, import_obsidian3.normalizePath)(INDEX_PATH));
      this.index = JSON.parse(raw);
    } catch (e) {
      this.index = {};
    }
  }
  async save() {
    if (!this.dirty) return;
    await ensureDir(this.app, ".neogdsync");
    await this.app.vault.adapter.write((0, import_obsidian3.normalizePath)(INDEX_PATH), JSON.stringify(this.index, null, 2));
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
  /**
   * Partial rebuild: re-crawl one folder subtree on Drive without touching the rest of the index.
   * Stale entries under the prefix are removed; entries outside are untouched.
   * Returns false if the Drive folder cannot be located (no creation attempted).
   */
  async rebuildFolder(folderPath, onProgress) {
    const cached2 = this.index[folderPath];
    let folderId = (cached2 == null ? void 0 : cached2.isFolder) ? cached2.driveId : null;
    if (!folderId) {
      folderId = await this.lookupFolderOnDrive(folderPath);
      if (!folderId) return false;
      this.set(folderPath, { driveId: folderId, driveMtime: (/* @__PURE__ */ new Date()).toISOString(), syncedAt: Date.now(), isFolder: true });
    }
    const prefix = folderPath + "/";
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
  async lookupFolderOnDrive(localPath) {
    const parts = localPath.split("/");
    let currentId = this.vaultRootId;
    let builtPath = "";
    for (const part of parts) {
      builtPath = builtPath ? `${builtPath}/${part}` : part;
      const cached2 = this.index[builtPath];
      if (cached2 == null ? void 0 : cached2.isFolder) {
        currentId = cached2.driveId;
        continue;
      }
      const children = await this.drive.listChildren(currentId);
      const found = children.find((c) => c.name === part && c.mimeType === FOLDER_MIME2);
      if (!found) return null;
      currentId = found.id;
    }
    return currentId;
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
  const norm = (0, import_obsidian3.normalizePath)(path);
  if (!await app.vault.adapter.exists(norm)) {
    await app.vault.adapter.mkdir(norm);
  }
}

// src/snapshot.ts
var VaultSnapshot = class {
  constructor(app) {
    this.app = app;
    this.snapshot = {};
  }
  /** Injected by plugin.loadSettings() — purges config dir entries defensively. */
  setRaw(data) {
    const raw = data || {};
    const configDir = this.app.vault.configDir;
    for (const key of Object.keys(raw)) {
      if (key.startsWith(configDir)) delete raw[key];
    }
    this.snapshot = raw;
  }
  /** No-op: data is injected via setRaw() from loadSettings(). */
  load() {
  }
  /**
   * Rebuild snapshot from current vault state.
   * Updates in-memory snapshot only; caller must call saveSettings() to persist.
   */
  save(exclude) {
    const fresh = {};
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
      } else if (f.stat.mtime - snap.mtime > 2e3 || f.stat.size !== snap.size) {
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
var import_obsidian4 = require("obsidian");

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
    var _a, _b, _c, _d;
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    this.onProgress("Scanning local changes\u2026");
    const offlineDiff = this.snapshot.computeDiff((p) => this.exclude(p));
    for (const [path, op] of Object.entries(offlineDiff)) {
      if (!this.pendingOps[path]) this.pendingOps[path] = op;
    }
    this.onProgress("Fetching drive changes\u2026");
    let changes = [];
    let newToken = this.settings.changesToken;
    try {
      if (!this.settings.changesToken) {
        this.settings.changesToken = await this.drive.getStartPageToken();
      }
      const r = await this.drive.getChanges(this.settings.changesToken);
      changes = r.changes;
      newToken = r.newToken;
    } catch (err) {
      console.warn(
        "[NeoGDSync] Could not fetch Drive changes, pushing local changes only:",
        err instanceof Error ? err.message : String(err)
      );
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
        driveChanged.set(localPath, { removed: c.removed || ((_a = c.file) == null ? void 0 : _a.trashed) === true, mtime: (_b = c.file) == null ? void 0 : _b.modifiedTime });
      }
    }
    const FOLDER_MIME3 = "application/vnd.google-apps.folder";
    const unknownChanges = changes.filter(
      (c) => {
        var _a2;
        return !driveIdToPath.has(c.fileId) && !c.removed && !((_a2 = c.file) == null ? void 0 : _a2.trashed);
      }
    );
    if (unknownChanges.length > 0) {
      const folderIdToPath = /* @__PURE__ */ new Map();
      folderIdToPath.set(this.settings.vaultRootId, "");
      for (const p of this.index.allPaths()) {
        const e = this.index.get(p);
        if (e == null ? void 0 : e.isFolder) folderIdToPath.set(e.driveId, p);
      }
      for (const c of unknownChanges) {
        try {
          const meta = await this.drive.getFileMeta(c.fileId);
          if (meta.trashed || meta.mimeType !== FOLDER_MIME3) continue;
          const parentId = (_c = meta.parents) == null ? void 0 : _c[0];
          if (!parentId) continue;
          const parentPath = folderIdToPath.get(parentId);
          if (parentPath === void 0) continue;
          const folderLocalPath = parentPath ? `${parentPath}/${meta.name}` : meta.name;
          if (this.exclude(folderLocalPath)) continue;
          folderIdToPath.set(c.fileId, folderLocalPath);
          this.index.set(folderLocalPath, {
            driveId: c.fileId,
            driveMtime: meta.modifiedTime,
            syncedAt: 0,
            isFolder: true
          });
        } catch (err) {
          console.warn(
            `[NeoGDSync] Could not resolve unknown folder ${c.fileId}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
      for (const c of unknownChanges) {
        try {
          const meta = await this.drive.getFileMeta(c.fileId);
          if (meta.trashed) continue;
          if (meta.mimeType === FOLDER_MIME3) continue;
          const parentId = (_d = meta.parents) == null ? void 0 : _d[0];
          if (!parentId) {
            console.warn(`[NeoGDSync] Unknown fileId ${c.fileId} (${meta.name}) has no parent, skipping`);
            continue;
          }
          const folderPath = folderIdToPath.get(parentId);
          if (folderPath === void 0) {
            console.warn(`[NeoGDSync] Unknown fileId ${c.fileId} (${meta.name}): parent folder ${parentId} not in index \u2014 run Rebuild Index to repair`);
            continue;
          }
          const localPath = folderPath ? `${folderPath}/${meta.name}` : meta.name;
          if (this.exclude(localPath)) continue;
          this.index.set(localPath, {
            driveId: c.fileId,
            driveMtime: meta.modifiedTime,
            syncedAt: 0,
            isFolder: false
          });
          driveIdToPath.set(c.fileId, localPath);
          driveChanged.set(localPath, { removed: false, mtime: meta.modifiedTime });
        } catch (err) {
          console.warn(
            `[NeoGDSync] Could not resolve unknown fileId ${c.fileId}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
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
      } catch (err) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const handled = /* @__PURE__ */ new Set([...result.pushed, ...result.pulled, ...result.deleted]);
    await this.pullNewFromDrive(driveChanged, result, handled);
    this.settings.changesToken = newToken;
    this.settings.lastSyncedAt = Date.now();
    this.snapshot.save((p) => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pushed, ...result.deleted, ...result.pulled]) {
      delete this.pendingOps[p];
    }
    return result;
  }
  // ── Force Push ─────────────────────────────────────────────────
  async forcePush(folderFilter) {
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const prefix = folderFilter ? normFolder(folderFilter) : void 0;
    const offlineDiff = this.snapshot.computeDiff((p) => this.exclude(p));
    for (const [path, op] of Object.entries(offlineDiff)) {
      if (!this.pendingOps[path]) this.pendingOps[path] = op;
    }
    const allOps = Object.entries(this.pendingOps).filter(([path]) => !prefix || matchesFolder(path, prefix));
    let done = 0;
    for (const [path, op] of allOps) {
      this.onProgress(`[${++done}/${allOps.length}] push: ${path}`);
      if (this.exclude(path)) continue;
      try {
        if (op === "delete") await this.handleDelete(path, result);
        else await this.handlePush(path, op, result);
      } catch (err) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    if (!this.settings.changesToken) {
      this.settings.changesToken = await this.drive.getStartPageToken();
    }
    this.snapshot.save((p) => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pushed, ...result.deleted, ...result.pulled]) {
      delete this.pendingOps[p];
    }
    return result;
  }
  // ── Force Pull ─────────────────────────────────────────────────
  async forcePull(folderFilter) {
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const prefix = folderFilter ? normFolder(folderFilter) : void 0;
    if (prefix) {
      this.onProgress(`Rebuilding index for ${prefix}\u2026`);
      const found = await this.index.rebuildFolder(prefix, (msg) => this.onProgress(`Crawling: ${msg}`));
      if (!found) {
        result.errors.push({ path: prefix, error: `Folder not found on Drive: ${prefix}` });
        return result;
      }
    } else {
      this.onProgress("Rebuilding drive index\u2026");
      await this.index.rebuild((msg) => this.onProgress(`Crawling: ${msg}`));
    }
    const paths = this.index.allPaths().filter((p) => !prefix || matchesFolder(p, prefix));
    let done = 0;
    for (const path of paths) {
      const entry = this.index.get(path);
      if (!entry || entry.isFolder) continue;
      this.onProgress(`[${++done}] pull: ${path}`);
      try {
        const bytes = await this.drive.downloadFile(entry.driveId);
        await writeLocal(this.app, path, bytes);
        result.pulled.push(path);
      } catch (err) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.settings.lastSyncedAt = Date.now();
    this.snapshot.save((p) => this.exclude(p));
    await this.index.save();
    for (const p of [...result.pulled, ...result.deleted]) {
      delete this.pendingOps[p];
    }
    return result;
  }
  // ── Internal helpers ───────────────────────────────────────────
  async handlePush(path, op, result) {
    var _a;
    const file = this.app.vault.getAbstractFileByPath((0, import_obsidian4.normalizePath)(path));
    if (!file || !(file instanceof import_obsidian4.TFile)) {
      result.pushed.push(path);
      return;
    }
    const bytes = await this.app.vault.readBinary(file);
    const mtime = new Date(file.stat.mtime).toISOString();
    const mimeType = fromPath(path);
    const cached2 = this.index.get(path);
    if (cached2 && !cached2.isFolder) {
      if (op === "create") {
        const targetParentId = await this.index.resolveParentFolder(path);
        const meta = await this.drive.getFileMeta(cached2.driveId);
        const currentParentId = (_a = meta.parents) == null ? void 0 : _a[0];
        if (currentParentId && currentParentId !== targetParentId) {
          await this.drive.moveFile(cached2.driveId, currentParentId, targetParentId);
        }
      }
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
        this.index.delete(path);
        result.deleted.push(path);
      } catch (err) {
        result.errors.push({ path, error: `Drive delete failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else {
      result.deleted.push(path);
    }
  }
  async handleConflict(path, driveMtime, result) {
    const entry = this.index.get(path);
    if (!entry) return;
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
    const base = ext ? path.slice(0, -ext.length) : path;
    const conflictPath = `${base}.conflict${ext}`;
    const localFile = this.app.vault.getAbstractFileByPath((0, import_obsidian4.normalizePath)(path));
    const localMtime = localFile instanceof import_obsidian4.TFile ? localFile.stat.mtime : 0;
    if (localFile instanceof import_obsidian4.TFile) {
      const localBytes = await this.app.vault.readBinary(localFile);
      await writeLocal(this.app, conflictPath, localBytes);
    }
    const driveBytes = await this.drive.downloadFile(entry.driveId);
    await writeLocal(this.app, path, driveBytes);
    this.index.set(path, { ...entry, driveMtime, syncedAt: Date.now() });
    result.conflicts.push({ localPath: path, localMtime, driveMtime, conflictCopyPath: conflictPath, detectedAt: Date.now() });
    result.pulled.push(path);
  }
  async pullNewFromDrive(driveChanged, result, handled) {
    for (const [path, change] of driveChanged.entries()) {
      if (this.exclude(path)) continue;
      if (handled.has(path)) continue;
      if (change.removed) {
        const localFile = this.app.vault.getAbstractFileByPath((0, import_obsidian4.normalizePath)(path));
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
      } catch (err) {
        result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
};
async function writeLocal(app, path, bytes) {
  const norm = (0, import_obsidian4.normalizePath)(path);
  const parts = path.split("/");
  if (parts.length > 1) {
    const dir = (0, import_obsidian4.normalizePath)(parts.slice(0, -1).join("/"));
    if (!await app.vault.adapter.exists(dir)) {
      await app.vault.adapter.mkdir(dir);
    }
  }
  const existing = app.vault.getAbstractFileByPath(norm);
  if (existing instanceof import_obsidian4.TFile) {
    await app.vault.modifyBinary(existing, bytes);
  } else {
    await app.vault.createBinary(norm, bytes);
  }
}
function normFolder(p) {
  return p.replace(/^\/+|\/+$/g, "");
}
function matchesFolder(filePath, folder) {
  return filePath === folder || filePath.startsWith(folder + "/");
}
function matchGlob(pattern, path) {
  let r = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      r += ".*";
      i++;
    } else if (c === "*") {
      r += "[^/]*";
    } else if (c === "?") {
      r += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      r += "\\" + c;
    } else {
      r += c;
    }
  }
  return new RegExp("^" + r + "$").test(path);
}

// src/main.ts
var NeoGDSync = class extends import_obsidian5.Plugin {
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
    this.drive = new DriveApi(this.settings.refreshToken, this.settings.authProxyUrl);
    this.index = new PathIndex(this.app, this.drive, this.settings.vaultRootId);
    await this.index.load();
    this.app.workspace.onLayoutReady(() => {
      console.debug(`[NeoGDSync] onLayoutReady: vault has ${this.app.vault.getFiles().length} files`);
      this.mergeOfflineDiff();
      this.registerEvents();
    });
    const ribbonIcon = this.addRibbonIcon("cloud", "Sync vault", () => this.openSyncModal());
    ribbonIcon.addClass("neogdsync-ribbon");
    this.statusEl = this.addStatusBarItem();
    this.updateStatus();
    this.addCommand({ id: "smart-sync", name: "Smart sync (auto conflict detect)", callback: () => this.runSync("smart") });
    this.addCommand({ id: "force-push", name: "Force push (local \u2192 drive)", callback: () => this.runSync("push") });
    this.addCommand({ id: "force-pull", name: "Force pull (drive \u2192 local)", callback: () => this.runSync("pull") });
    this.addCommand({ id: "rebuild-index", name: "Rebuild drive index", callback: () => this.rebuildIndex() });
    this.addCommand({ id: "show-conflicts", name: "Show conflicts", callback: () => this.showConflicts() });
    this.addSettingTab(new NeoSettingsTab(this.app, this));
    this.registerObsidianProtocolHandler("neogdsync", (params) => {
      const mode = params.mode === "push" ? "push" : params.mode === "pull" ? "pull" : "smart";
      void this.runSync(mode);
    });
    new import_obsidian5.Notice("Sync plugin loaded");
  }
  async onunload() {
    this.snapshot.save((p) => this.exclude(p));
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
    if (path.startsWith(this.app.vault.configDir)) return true;
    if (path.startsWith(".smart-env")) return true;
    if (path.startsWith(".smtcmp")) return true;
    if (path.endsWith(".DS_Store")) return true;
    return false;
  }
  handleCreate(f) {
    if (this.syncing) return;
    if (this.exclude(f.path)) return;
    if (!(f instanceof import_obsidian5.TFile)) return;
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
    if (this.syncing) return;
    if (this.exclude(f.path) || !(f instanceof import_obsidian5.TFile)) return;
    const snap = this.snapshot.get(f.path);
    if (snap && Math.abs(f.stat.mtime - snap.mtime) <= 2e3 && f.stat.size === snap.size) return;
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
    if (!(f instanceof import_obsidian5.TFile)) {
      this.index.rename(oldPath, f.path);
      this.updateStatus();
      this.debouncedSave();
      return;
    }
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
    const snapData = this.snapshot.getAll();
    const snapCount = Object.keys(snapData).length;
    console.debug(`[NeoGDSync] mergeOfflineDiff: snapshot=${snapCount}, vault=${this.app.vault.getFiles().length}`);
    if (snapCount === 0) {
      console.debug("[NeoGDSync] No snapshot \u2014 saving current vault as baseline");
      this.snapshot.save((p) => this.exclude(p));
      void this.saveSettings();
      return;
    }
    const diff = this.snapshot.computeDiff((p) => this.exclude(p));
    const diffEntries = Object.entries(diff);
    console.debug(`[NeoGDSync] computeDiff: ${diffEntries.length} ops`);
    for (const [path, op] of diffEntries.slice(0, 5)) {
      const f = this.app.vault.getAbstractFileByPath(path);
      const snap = snapData[path];
      if (f instanceof import_obsidian5.TFile && snap) {
        console.debug(`[NeoGDSync]   ${op}: ${path} mtime diff=${f.stat.mtime - snap.mtime}ms size: ${snap.size}\u2192${f.stat.size}`);
      } else {
        console.debug(`[NeoGDSync]   ${op}: ${path} f=${!!f} snap=${!!snap}`);
      }
    }
    let count = 0;
    for (const [path, op] of diffEntries) {
      if (!this.pendingOps[path]) {
        this.pendingOps[path] = op;
        count++;
      }
    }
    console.debug(count > 0 ? `[NeoGDSync] Startup diff: ${count} offline changes` : "[NeoGDSync] Startup diff: 0 changes \u2014 snapshot is current");
    this.updateStatus();
  }
  // ── Sync ───────────────────────────────────────────────────────
  async runSync(mode, folderFilter) {
    if (this.syncing) {
      new import_obsidian5.Notice("Sync already in progress");
      return;
    }
    if (!this.settings.refreshToken) {
      new import_obsidian5.Notice("No refresh token configured");
      return;
    }
    const folder = folderFilter ? normFolder(folderFilter) : void 0;
    this.syncing = true;
    this.updateStatus("Syncing\u2026");
    const notice = new import_obsidian5.Notice(folder ? `Sync ${folder}\u2026` : "Sync started\u2026", 0);
    try {
      const syncer = new Syncer(
        this.app,
        this.drive,
        this.index,
        this.snapshot,
        this.settings,
        this.pendingOps,
        (msg) => {
          notice.setMessage(msg);
        }
      );
      let result;
      if (mode === "push") result = await syncer.forcePush(folder);
      else if (mode === "pull") result = await syncer.forcePull(folder);
      else result = await syncer.smartSync();
      this.conflicts.push(...result.conflicts);
      this.settings.lastSyncedAt = Date.now();
      await this.saveSettings();
      await this.index.save();
      const summary = `\u2191${result.pushed.length} \u2193${result.pulled.length} \u{1F5D1}${result.deleted.length}` + (result.conflicts.length ? ` \u26A0\uFE0F${result.conflicts.length} conflicts` : "") + (result.errors.length ? ` \u274C${result.errors.length} errors` : "");
      notice.setMessage(`Done \u2014 ${summary}`);
      setTimeout(() => notice.hide(), 4e3);
      if (result.errors.length) console.error("[NeoGDSync] Errors:", result.errors);
      if (result.conflicts.length) new import_obsidian5.Notice(`${result.conflicts.length} conflict(s) detected`, 6e3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notice.setMessage(`Sync error: ${msg}`);
      setTimeout(() => notice.hide(), 5e3);
      console.error("[NeoGDSync]", err);
      this.syncing = false;
      this.updateStatus();
      return;
    }
    setTimeout(() => {
      this.snapshot.save((p) => this.exclude(p));
      void this.saveSettings().finally(() => {
        this.syncing = false;
        this.updateStatus();
      });
    }, 600);
  }
  async rebuildIndex() {
    if (this.syncing) {
      new import_obsidian5.Notice("Sync in progress");
      return;
    }
    this.syncing = true;
    const notice = new import_obsidian5.Notice("Rebuilding drive index\u2026", 0);
    try {
      await this.index.rebuild((msg) => notice.setMessage(msg));
      notice.setMessage("Drive index rebuilt");
      setTimeout(() => notice.hide(), 3e3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notice.setMessage(`Rebuild failed: ${msg}`);
      setTimeout(() => notice.hide(), 5e3);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }
  showConflicts() {
    new ConflictModal(this.app, this).open();
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
    this.saveTimer = setTimeout(() => {
      void this.saveSettings();
    }, 500);
  }
  async loadSettings() {
    var _a, _b, _c;
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (_a = saved == null ? void 0 : saved.settings) != null ? _a : {});
    this.pendingOps = (_b = saved == null ? void 0 : saved.pendingOps) != null ? _b : {};
    this.conflicts = (_c = saved == null ? void 0 : saved.conflicts) != null ? _c : [];
    if (this.snapshot) this.snapshot.setRaw(saved == null ? void 0 : saved.snapshot);
    const legacyUrls = [
      "https://ogd.richardxiong.com/api/access",
      "https://neogdsync-oauth.neogdsync.workers.dev"
    ];
    if (legacyUrls.includes(this.settings.authProxyUrl)) {
      this.settings.authProxyUrl = DEFAULT_SETTINGS.authProxyUrl;
      await this.saveSettings();
    }
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
var SyncModal = class extends import_obsidian5.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Sync" });
    const pending = Object.keys(this.plugin.pendingOps).length;
    contentEl.createEl("p", { text: `Pending operations: ${pending}` });
    if (pending > 0) {
      const ul = contentEl.createEl("ul");
      for (const [p, op] of Object.entries(this.plugin.pendingOps).slice(0, 20)) {
        ul.createEl("li", { text: `${op}: ${p}` });
      }
      if (pending > 20) ul.createEl("li", { text: `\u2026 and ${pending - 20} more` });
    }
    const filterRow = contentEl.createDiv({ cls: "neogdsync-filter-row" });
    filterRow.createEl("label", { text: "Folder (optional): ", attr: { for: "neogdsync-folder-input" } });
    const folderInput = filterRow.createEl("input", {
      cls: "neogdsync-folder-input",
      attr: { id: "neogdsync-folder-input", type: "text", placeholder: "e.g. 2026/2026-04" }
    });
    const getFolder = () => folderInput.value.trim() || void 0;
    const btnRow = contentEl.createDiv({ cls: "neogdsync-btn-row" });
    btnRow.createEl("button", { text: "Smart sync" }).onclick = () => {
      this.close();
      void this.plugin.runSync("smart");
    };
    btnRow.createEl("button", { text: "Force push" }).onclick = () => {
      this.close();
      void this.plugin.runSync("push", getFolder());
    };
    btnRow.createEl("button", { text: "Force pull" }).onclick = () => {
      this.close();
      void this.plugin.runSync("pull", getFolder());
    };
    if (this.plugin.conflicts.length > 0) {
      btnRow.createEl("button", { text: `${this.plugin.conflicts.length} conflicts` }).onclick = () => {
        this.close();
        this.plugin.showConflicts();
      };
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ConflictModal = class extends import_obsidian5.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Conflicts" });
    const conflicts = this.plugin.conflicts;
    if (!conflicts.length) {
      contentEl.createEl("p", { text: "No conflicts." });
      return;
    }
    for (const c of conflicts) {
      const div = contentEl.createDiv({ cls: "neogdsync-conflict" });
      div.createEl("strong", { text: c.localPath });
      div.createEl("br");
      div.createEl("small", { text: `Local: ${new Date(c.localMtime).toLocaleString()} | Drive: ${new Date(c.driveMtime).toLocaleString()}` });
      div.createEl("br");
      div.createEl("small", { text: `Drive copy saved as: ${c.conflictCopyPath}` });
    }
    contentEl.createEl("hr");
    contentEl.createEl("button", { text: "Clear all conflicts" }).onclick = async () => {
      this.plugin.conflicts = [];
      await this.plugin.saveSettings();
      this.close();
      new import_obsidian5.Notice("Conflicts cleared");
    };
  }
  onClose() {
    this.contentEl.empty();
  }
};
var NeoSettingsTab = class extends import_obsidian5.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian5.Setting(containerEl).setHeading();
    const proxyUrl = this.plugin.settings.authProxyUrl;
    const isConnected = !!this.plugin.settings.refreshToken;
    const authSetting = new import_obsidian5.Setting(containerEl).setName("Google Drive").setDesc(isConnected ? "\u2705 Connected \u2014 token saved" : "Not connected");
    if (isConnected) {
      authSetting.addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(async () => {
        this.plugin.settings.refreshToken = "";
        this.plugin.drive = new DriveApi("", this.plugin.settings.authProxyUrl);
        clearTokenCache();
        await this.plugin.saveSettings();
        this.display();
      }));
    } else {
      authSetting.addButton((b) => b.setButtonText("Connect Google Drive").setCta().onClick(() => {
        window.open(`${proxyUrl}/authorize`, "_blank");
        this.display();
      }));
    }
    new import_obsidian5.Setting(containerEl).setName("Refresh token").setDesc(isConnected ? "Token is set. Re-paste to update." : 'Complete "Connect" above, then paste the token here.').addText((t) => t.setPlaceholder("1//05o\u2026").setValue(this.plugin.settings.refreshToken).onChange(async (v) => {
      this.plugin.settings.refreshToken = v.trim();
      this.plugin.drive = new DriveApi(v.trim(), this.plugin.settings.authProxyUrl);
      clearTokenCache();
      await this.plugin.saveSettings();
      this.display();
    }));
    new import_obsidian5.Setting(containerEl).setName("Vault root folder ID").setDesc("Google Drive folder ID that is the root of this vault. Change requires plugin reload.").addText((t) => {
      t.inputEl.addClass("neogdsync-monospace-input");
      t.setPlaceholder("Root folder ID").setValue(this.plugin.settings.vaultRootId).onChange(async (v) => {
        this.plugin.settings.vaultRootId = v.trim();
        this.plugin.index = new PathIndex(this.plugin.app, this.plugin.drive, v.trim());
        await this.plugin.index.load();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian5.Setting(containerEl).setName("Sync mode").setDesc("Default sync mode when using ribbon icon").addDropdown((d) => d.addOption("smart", "Smart (conflict detect)").addOption("push", "Force push").addOption("pull", "Force pull").setValue(this.plugin.settings.syncMode).onChange(async (v) => {
      this.plugin.settings.syncMode = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian5.Setting(containerEl).setName("Keep revisions").setDesc("Keep file revisions on drive (version history)").addToggle((t) => t.setValue(this.plugin.settings.keepRevisions).onChange(async (v) => {
      this.plugin.settings.keepRevisions = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian5.Setting(containerEl).setName("Pending ops").setDesc(`${Object.keys(this.plugin.pendingOps).length} files queued`).addButton((b) => b.setButtonText("Clear all").onClick(async () => {
      this.plugin.pendingOps = {};
      await this.plugin.saveSettings();
      this.plugin.updateStatus();
      this.display();
    }));
    new import_obsidian5.Setting(containerEl).setName("Rebuild drive index").setDesc("Crawl drive vault from root and rebuild local index").addButton((b) => b.setButtonText("Rebuild").onClick(() => {
      void this.plugin.rebuildIndex();
    }));
    new import_obsidian5.Setting(containerEl).setName("Status").setHeading();
    new import_obsidian5.Setting(containerEl).setName(`Last sync: ${this.plugin.settings.lastSyncedAt ? new Date(this.plugin.settings.lastSyncedAt).toLocaleString() : "never"}`).setDesc(`Conflicts: ${this.plugin.conflicts.length}`);
  }
};
