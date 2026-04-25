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
  authProxyUrl: "https://ogd.richardxiong.com/api/access",
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
var DEFAULT_PROXY_URL = "https://ogd.richardxiong.com/api/access";
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
async function driveRequest(method, url, body, headers, refreshToken) {
  const token = refreshToken ? await getAccessToken(refreshToken) : "";
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
  constructor(refreshToken) {
    this.refreshToken = refreshToken;
  }
  request(method, url, body, headers) {
    return driveRequest(method, url, body, headers, this.refreshToken);
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
  async renameFile(driveId, newName) {
    await this.request(
      "PATCH",
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ name: newName }),
      { "Content-Type": "application/json" }
    );
  }
  async deleteFile(driveId) {
    await this.request("DELETE", `${BASE}/files/${driveId}`);
  }
  async downloadFile(driveId) {
    const resp = await this.request("GET", `${BASE}/files/${driveId}?alt=media`);
    return resp.arrayBuffer;
  }
  async getFileMeta(driveId) {
    const resp = await this.request("GET", `${BASE}/files/${driveId}?fields=id,name,mimeType,modifiedTime,parents,size`);
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
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime))"
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
    var _a, _b;
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
        driveChanged.set(localPath, { removed: c.removed, mtime: (_a = c.file) == null ? void 0 : _a.modifiedTime });
      }
    }
    const FOLDER_MIME3 = "application/vnd.google-apps.folder";
    const unknownChanges = changes.filter((c) => !driveIdToPath.has(c.fileId) && !c.removed);
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
          if (meta.mimeType === FOLDER_MIME3) continue;
          const parentId = (_b = meta.parents) == null ? void 0 : _b[0];
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
  async forcePush() {
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    const allOps = Object.entries(this.pendingOps);
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
  async forcePull() {
    const result = { pushed: [], pulled: [], deleted: [], conflicts: [], errors: [] };
    this.onProgress("Rebuilding drive index\u2026");
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
    const file = this.app.vault.getAbstractFileByPath((0, import_obsidian4.normalizePath)(path));
    if (!file || !(file instanceof import_obsidian4.TFile)) return;
    const bytes = await this.app.vault.readBinary(file);
    const mtime = new Date(file.stat.mtime).toISOString();
    const mimeType = fromPath(path);
    const cached2 = this.index.get(path);
    if (cached2 && !cached2.isFolder) {
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
    this.drive = new DriveApi(this.settings.refreshToken);
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
  async runSync(mode) {
    if (this.syncing) {
      new import_obsidian5.Notice("Sync already in progress");
      return;
    }
    if (!this.settings.refreshToken) {
      new import_obsidian5.Notice("No refresh token configured");
      return;
    }
    this.syncing = true;
    this.updateStatus("Syncing\u2026");
    const notice = new import_obsidian5.Notice("Sync started\u2026", 0);
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
      if (mode === "push") result = await syncer.forcePush();
      else if (mode === "pull") result = await syncer.forcePull();
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
    const btnRow = contentEl.createDiv({ cls: "neogdsync-btn-row" });
    btnRow.createEl("button", { text: "Smart sync" }).onclick = () => {
      this.close();
      void this.plugin.runSync("smart");
    };
    btnRow.createEl("button", { text: "Force push" }).onclick = () => {
      this.close();
      void this.plugin.runSync("push");
    };
    btnRow.createEl("button", { text: "Force pull" }).onclick = () => {
      this.close();
      void this.plugin.runSync("pull");
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
    new import_obsidian5.Setting(containerEl).setName("Refresh token").setDesc("Refresh token for Google Drive").addText((t) => t.setPlaceholder("1//05o\u2026").setValue(this.plugin.settings.refreshToken).onChange(async (v) => {
      this.plugin.settings.refreshToken = v.trim();
      this.plugin.drive = new DriveApi(v.trim());
      clearTokenCache();
      await this.plugin.saveSettings();
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3R5cGVzLnRzIiwgInNyYy9kcml2ZUFwaS50cyIsICJzcmMvYXV0aC50cyIsICJzcmMvcGF0aEluZGV4LnRzIiwgInNyYy9zbmFwc2hvdC50cyIsICJzcmMvc3luY2VyLnRzIiwgInNyYy9taW1lLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQge1xuICBQbHVnaW4sIE5vdGljZSwgVEZpbGUsIFRBYnN0cmFjdEZpbGUsXG4gIFBsdWdpblNldHRpbmdUYWIsIEFwcCwgU2V0dGluZywgTW9kYWwsXG59IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IE5lb1NldHRpbmdzLCBERUZBVUxUX1NFVFRJTkdTLCBQZW5kaW5nT3BzLCBDb25mbGljdFJlY29yZCwgU25hcHNob3QgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IERyaXZlQXBpIH0gZnJvbSAnLi9kcml2ZUFwaSc7XG5pbXBvcnQgeyBQYXRoSW5kZXggfSBmcm9tICcuL3BhdGhJbmRleCc7XG5pbXBvcnQgeyBWYXVsdFNuYXBzaG90IH0gZnJvbSAnLi9zbmFwc2hvdCc7XG5pbXBvcnQgeyBTeW5jZXIsIFN5bmNSZXN1bHQgfSBmcm9tICcuL3N5bmNlcic7XG5pbXBvcnQgeyBjbGVhclRva2VuQ2FjaGUgfSBmcm9tICcuL2F1dGgnO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBOZW9HRFN5bmMgZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5ncyE6IE5lb1NldHRpbmdzO1xuICBwZW5kaW5nT3BzOiBQZW5kaW5nT3BzID0ge307XG4gIGNvbmZsaWN0czogQ29uZmxpY3RSZWNvcmRbXSA9IFtdO1xuXG4gIGRyaXZlITogRHJpdmVBcGk7XG4gIGluZGV4ITogUGF0aEluZGV4O1xuICBzbmFwc2hvdCE6IFZhdWx0U25hcHNob3Q7XG4gIHByaXZhdGUgc3luY2luZyA9IGZhbHNlO1xuICBwcml2YXRlIHN0YXR1c0VsPzogSFRNTEVsZW1lbnQ7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIExpZmVjeWNsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgdGhpcy5zbmFwc2hvdCA9IG5ldyBWYXVsdFNuYXBzaG90KHRoaXMuYXBwKTtcbiAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuXG4gICAgdGhpcy5kcml2ZSA9IG5ldyBEcml2ZUFwaSh0aGlzLnNldHRpbmdzLnJlZnJlc2hUb2tlbik7XG4gICAgdGhpcy5pbmRleCA9IG5ldyBQYXRoSW5kZXgodGhpcy5hcHAsIHRoaXMuZHJpdmUsIHRoaXMuc2V0dGluZ3MudmF1bHRSb290SWQpO1xuICAgIGF3YWl0IHRoaXMuaW5kZXgubG9hZCgpO1xuXG4gICAgLy8gRGVsYXkgYm90aCBvZmZsaW5lIGRpZmYgQU5EIGV2ZW50IHJlZ2lzdHJhdGlvbiB1bnRpbCBsYXlvdXQgaXMgcmVhZHkuXG4gICAgLy8gQmVmb3JlIG9uTGF5b3V0UmVhZHksIHZhdWx0LmdldEZpbGVzKCkgcmV0dXJucyBzdGFsZSBzdGF0IHZhbHVlcy5cbiAgICB0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG4gICAgICBjb25zb2xlLmRlYnVnKGBbTmVvR0RTeW5jXSBvbkxheW91dFJlYWR5OiB2YXVsdCBoYXMgJHt0aGlzLmFwcC52YXVsdC5nZXRGaWxlcygpLmxlbmd0aH0gZmlsZXNgKTtcbiAgICAgIHRoaXMubWVyZ2VPZmZsaW5lRGlmZigpO1xuICAgICAgdGhpcy5yZWdpc3RlckV2ZW50cygpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgcmliYm9uSWNvbiA9IHRoaXMuYWRkUmliYm9uSWNvbignY2xvdWQnLCAnU3luYyB2YXVsdCcsICgpID0+IHRoaXMub3BlblN5bmNNb2RhbCgpKTtcbiAgICByaWJib25JY29uLmFkZENsYXNzKCduZW9nZHN5bmMtcmliYm9uJyk7XG5cbiAgICB0aGlzLnN0YXR1c0VsID0gdGhpcy5hZGRTdGF0dXNCYXJJdGVtKCk7XG4gICAgdGhpcy51cGRhdGVTdGF0dXMoKTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7IGlkOiAnc21hcnQtc3luYycsICAgIG5hbWU6ICdTbWFydCBzeW5jIChhdXRvIGNvbmZsaWN0IGRldGVjdCknLCBjYWxsYmFjazogKCkgPT4gdGhpcy5ydW5TeW5jKCdzbWFydCcpIH0pO1xuICAgIHRoaXMuYWRkQ29tbWFuZCh7IGlkOiAnZm9yY2UtcHVzaCcsICAgIG5hbWU6ICdGb3JjZSBwdXNoIChsb2NhbCBcdTIxOTIgZHJpdmUpJywgICAgICAgICBjYWxsYmFjazogKCkgPT4gdGhpcy5ydW5TeW5jKCdwdXNoJykgfSk7XG4gICAgdGhpcy5hZGRDb21tYW5kKHsgaWQ6ICdmb3JjZS1wdWxsJywgICAgbmFtZTogJ0ZvcmNlIHB1bGwgKGRyaXZlIFx1MjE5MiBsb2NhbCknLCAgICAgICAgICBjYWxsYmFjazogKCkgPT4gdGhpcy5ydW5TeW5jKCdwdWxsJykgfSk7XG4gICAgdGhpcy5hZGRDb21tYW5kKHsgaWQ6ICdyZWJ1aWxkLWluZGV4JywgbmFtZTogJ1JlYnVpbGQgZHJpdmUgaW5kZXgnLCAgICAgICAgICAgICAgICAgY2FsbGJhY2s6ICgpID0+IHRoaXMucmVidWlsZEluZGV4KCkgfSk7XG4gICAgdGhpcy5hZGRDb21tYW5kKHsgaWQ6ICdzaG93LWNvbmZsaWN0cycsIG5hbWU6ICdTaG93IGNvbmZsaWN0cycsICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2s6ICgpID0+IHRoaXMuc2hvd0NvbmZsaWN0cygpIH0pO1xuXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBOZW9TZXR0aW5nc1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgdGhpcy5yZWdpc3Rlck9ic2lkaWFuUHJvdG9jb2xIYW5kbGVyKCduZW9nZHN5bmMnLCAocGFyYW1zKSA9PiB7XG4gICAgICBjb25zdCBtb2RlID0gcGFyYW1zLm1vZGUgPT09ICdwdXNoJyA/ICdwdXNoJyA6IHBhcmFtcy5tb2RlID09PSAncHVsbCcgPyAncHVsbCcgOiAnc21hcnQnO1xuICAgICAgdm9pZCB0aGlzLnJ1blN5bmMobW9kZSk7XG4gICAgfSk7XG5cbiAgICBuZXcgTm90aWNlKCdTeW5jIHBsdWdpbiBsb2FkZWQnKTtcbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCkge1xuICAgIC8vIHNuYXBzaG90LnNhdmUoKSBNVVNUIGNvbWUgYmVmb3JlIHNhdmVTZXR0aW5ncygpIHNvIGZyZXNoIHN0YXRzIGFyZSBwZXJzaXN0ZWRcbiAgICB0aGlzLnNuYXBzaG90LnNhdmUocCA9PiB0aGlzLmV4Y2x1ZGUocCkpO1xuICAgIGF3YWl0IHRoaXMuc2F2ZVNldHRpbmdzKCk7XG4gICAgYXdhaXQgdGhpcy5pbmRleC5zYXZlKCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgVmF1bHQgZXZlbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHByaXZhdGUgcmVnaXN0ZXJFdmVudHMoKSB7XG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKCdjcmVhdGUnLCBmID0+IHRoaXMuaGFuZGxlQ3JlYXRlKGYpKSk7XG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKCdtb2RpZnknLCBmID0+IHRoaXMuaGFuZGxlTW9kaWZ5KGYpKSk7XG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKCdkZWxldGUnLCBmID0+IHRoaXMuaGFuZGxlRGVsZXRlKGYpKSk7XG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKCdyZW5hbWUnLCAoZiwgb2xkKSA9PiB0aGlzLmhhbmRsZVJlbmFtZShmLCBvbGQpKSk7XG4gIH1cblxuICBleGNsdWRlKHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGlmIChwYXRoLnN0YXJ0c1dpdGgoJy5uZW9nZHN5bmMnKSkgICAgICAgcmV0dXJuIHRydWU7XG4gICAgaWYgKHBhdGguc3RhcnRzV2l0aCh0aGlzLmFwcC52YXVsdC5jb25maWdEaXIpKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAocGF0aC5zdGFydHNXaXRoKCcuc21hcnQtZW52JykpICAgICAgIHJldHVybiB0cnVlO1xuICAgIGlmIChwYXRoLnN0YXJ0c1dpdGgoJy5zbXRjbXAnKSkgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgaWYgKHBhdGguZW5kc1dpdGgoJy5EU19TdG9yZScpKSAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZUNyZWF0ZShmOiBUQWJzdHJhY3RGaWxlKSB7XG4gICAgaWYgKHRoaXMuc3luY2luZykgcmV0dXJuO1xuICAgIGlmICh0aGlzLmV4Y2x1ZGUoZi5wYXRoKSkgcmV0dXJuO1xuICAgIGlmICghKGYgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybjtcbiAgICBjb25zdCBjdXIgPSB0aGlzLnBlbmRpbmdPcHNbZi5wYXRoXTtcbiAgICBpZiAoY3VyID09PSAnZGVsZXRlJykge1xuICAgICAgdGhpcy5wZW5kaW5nT3BzW2YucGF0aF0gPSAnbW9kaWZ5JztcbiAgICB9IGVsc2UgaWYgKCFjdXIpIHtcbiAgICAgIHRoaXMucGVuZGluZ09wc1tmLnBhdGhdID0gJ2NyZWF0ZSc7XG4gICAgfVxuICAgIHRoaXMudXBkYXRlU3RhdHVzKCk7XG4gICAgdGhpcy5kZWJvdW5jZWRTYXZlKCk7XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZU1vZGlmeShmOiBUQWJzdHJhY3RGaWxlKSB7XG4gICAgaWYgKHRoaXMuc3luY2luZykgcmV0dXJuO1xuICAgIGlmICh0aGlzLmV4Y2x1ZGUoZi5wYXRoKSB8fCAhKGYgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybjtcbiAgICBjb25zdCBzbmFwID0gdGhpcy5zbmFwc2hvdC5nZXQoZi5wYXRoKTtcbiAgICBpZiAoc25hcCAmJiBNYXRoLmFicyhmLnN0YXQubXRpbWUgLSBzbmFwLm10aW1lKSA8PSAyMDAwICYmIGYuc3RhdC5zaXplID09PSBzbmFwLnNpemUpIHJldHVybjtcbiAgICBpZiAoIXRoaXMucGVuZGluZ09wc1tmLnBhdGhdKSB7XG4gICAgICB0aGlzLnBlbmRpbmdPcHNbZi5wYXRoXSA9ICdtb2RpZnknO1xuICAgIH1cbiAgICB0aGlzLnVwZGF0ZVN0YXR1cygpO1xuICAgIHRoaXMuZGVib3VuY2VkU2F2ZSgpO1xuICB9XG5cbiAgcHJpdmF0ZSBoYW5kbGVEZWxldGUoZjogVEFic3RyYWN0RmlsZSkge1xuICAgIGlmICh0aGlzLmV4Y2x1ZGUoZi5wYXRoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBlbmRpbmdPcHNbZi5wYXRoXSA9PT0gJ2NyZWF0ZScpIHtcbiAgICAgIGRlbGV0ZSB0aGlzLnBlbmRpbmdPcHNbZi5wYXRoXTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5wZW5kaW5nT3BzW2YucGF0aF0gPSAnZGVsZXRlJztcbiAgICB9XG4gICAgdGhpcy5pbmRleC5kZWxldGUoZi5wYXRoKTtcbiAgICB0aGlzLnVwZGF0ZVN0YXR1cygpO1xuICAgIHRoaXMuZGVib3VuY2VkU2F2ZSgpO1xuICB9XG5cbiAgcHJpdmF0ZSBoYW5kbGVSZW5hbWUoZjogVEFic3RyYWN0RmlsZSwgb2xkUGF0aDogc3RyaW5nKSB7XG4gICAgaWYgKHRoaXMuZXhjbHVkZShmLnBhdGgpICYmIHRoaXMuZXhjbHVkZShvbGRQYXRoKSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLnBlbmRpbmdPcHNbb2xkUGF0aF0gPT09ICdjcmVhdGUnKSB7XG4gICAgICBkZWxldGUgdGhpcy5wZW5kaW5nT3BzW29sZFBhdGhdO1xuICAgICAgdGhpcy5wZW5kaW5nT3BzW2YucGF0aF0gPSAnY3JlYXRlJztcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5wZW5kaW5nT3BzW29sZFBhdGhdID0gJ2RlbGV0ZSc7XG4gICAgICB0aGlzLnBlbmRpbmdPcHNbZi5wYXRoXSA9ICdjcmVhdGUnO1xuICAgIH1cbiAgICB0aGlzLmluZGV4LnJlbmFtZShvbGRQYXRoLCBmLnBhdGgpO1xuICAgIHRoaXMudXBkYXRlU3RhdHVzKCk7XG4gICAgdGhpcy5kZWJvdW5jZWRTYXZlKCk7XG4gIH1cblxuICBwcml2YXRlIG1lcmdlT2ZmbGluZURpZmYoKSB7XG4gICAgY29uc3Qgc25hcERhdGEgPSB0aGlzLnNuYXBzaG90LmdldEFsbCgpO1xuICAgIGNvbnN0IHNuYXBDb3VudCA9IE9iamVjdC5rZXlzKHNuYXBEYXRhKS5sZW5ndGg7XG4gICAgY29uc29sZS5kZWJ1ZyhgW05lb0dEU3luY10gbWVyZ2VPZmZsaW5lRGlmZjogc25hcHNob3Q9JHtzbmFwQ291bnR9LCB2YXVsdD0ke3RoaXMuYXBwLnZhdWx0LmdldEZpbGVzKCkubGVuZ3RofWApO1xuXG4gICAgaWYgKHNuYXBDb3VudCA9PT0gMCkge1xuICAgICAgY29uc29sZS5kZWJ1ZygnW05lb0dEU3luY10gTm8gc25hcHNob3QgXHUyMDE0IHNhdmluZyBjdXJyZW50IHZhdWx0IGFzIGJhc2VsaW5lJyk7XG4gICAgICB0aGlzLnNuYXBzaG90LnNhdmUocCA9PiB0aGlzLmV4Y2x1ZGUocCkpO1xuICAgICAgdm9pZCB0aGlzLnNhdmVTZXR0aW5ncygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGRpZmYgPSB0aGlzLnNuYXBzaG90LmNvbXB1dGVEaWZmKHAgPT4gdGhpcy5leGNsdWRlKHApKTtcbiAgICBjb25zdCBkaWZmRW50cmllcyA9IE9iamVjdC5lbnRyaWVzKGRpZmYpO1xuICAgIGNvbnNvbGUuZGVidWcoYFtOZW9HRFN5bmNdIGNvbXB1dGVEaWZmOiAke2RpZmZFbnRyaWVzLmxlbmd0aH0gb3BzYCk7XG5cbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBvcF0gb2YgZGlmZkVudHJpZXMuc2xpY2UoMCwgNSkpIHtcbiAgICAgIGNvbnN0IGYgPSB0aGlzLmFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG4gICAgICBjb25zdCBzbmFwID0gc25hcERhdGFbcGF0aF07XG4gICAgICBpZiAoZiBpbnN0YW5jZW9mIFRGaWxlICYmIHNuYXApIHtcbiAgICAgICAgY29uc29sZS5kZWJ1ZyhgW05lb0dEU3luY10gICAke29wfTogJHtwYXRofSBtdGltZSBkaWZmPSR7Zi5zdGF0Lm10aW1lIC0gc25hcC5tdGltZX1tcyBzaXplOiAke3NuYXAuc2l6ZX1cdTIxOTIke2Yuc3RhdC5zaXplfWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5kZWJ1ZyhgW05lb0dEU3luY10gICAke29wfTogJHtwYXRofSBmPSR7ISFmfSBzbmFwPSR7ISFzbmFwfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBjb3VudCA9IDA7XG4gICAgZm9yIChjb25zdCBbcGF0aCwgb3BdIG9mIGRpZmZFbnRyaWVzKSB7XG4gICAgICBpZiAoIXRoaXMucGVuZGluZ09wc1twYXRoXSkgeyB0aGlzLnBlbmRpbmdPcHNbcGF0aF0gPSBvcDsgY291bnQrKzsgfVxuICAgIH1cbiAgICBjb25zb2xlLmRlYnVnKGNvdW50ID4gMFxuICAgICAgPyBgW05lb0dEU3luY10gU3RhcnR1cCBkaWZmOiAke2NvdW50fSBvZmZsaW5lIGNoYW5nZXNgXG4gICAgICA6ICdbTmVvR0RTeW5jXSBTdGFydHVwIGRpZmY6IDAgY2hhbmdlcyBcdTIwMTQgc25hcHNob3QgaXMgY3VycmVudCcpO1xuICAgIHRoaXMudXBkYXRlU3RhdHVzKCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3luYyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBhc3luYyBydW5TeW5jKG1vZGU6ICdzbWFydCcgfCAncHVzaCcgfCAncHVsbCcpIHtcbiAgICBpZiAodGhpcy5zeW5jaW5nKSB7IG5ldyBOb3RpY2UoJ1N5bmMgYWxyZWFkeSBpbiBwcm9ncmVzcycpOyByZXR1cm47IH1cbiAgICBpZiAoIXRoaXMuc2V0dGluZ3MucmVmcmVzaFRva2VuKSB7IG5ldyBOb3RpY2UoJ05vIHJlZnJlc2ggdG9rZW4gY29uZmlndXJlZCcpOyByZXR1cm47IH1cblxuICAgIHRoaXMuc3luY2luZyA9IHRydWU7XG4gICAgdGhpcy51cGRhdGVTdGF0dXMoJ1N5bmNpbmdcdTIwMjYnKTtcbiAgICBjb25zdCBub3RpY2UgPSBuZXcgTm90aWNlKCdTeW5jIHN0YXJ0ZWRcdTIwMjYnLCAwKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBzeW5jZXIgPSBuZXcgU3luY2VyKFxuICAgICAgICB0aGlzLmFwcCwgdGhpcy5kcml2ZSwgdGhpcy5pbmRleCwgdGhpcy5zbmFwc2hvdCxcbiAgICAgICAgdGhpcy5zZXR0aW5ncywgdGhpcy5wZW5kaW5nT3BzLFxuICAgICAgICAobXNnOiBzdHJpbmcpID0+IHsgbm90aWNlLnNldE1lc3NhZ2UobXNnKTsgfSxcbiAgICAgICk7XG5cbiAgICAgIGxldCByZXN1bHQ6IFN5bmNSZXN1bHQ7XG4gICAgICBpZiAobW9kZSA9PT0gJ3B1c2gnKSByZXN1bHQgPSBhd2FpdCBzeW5jZXIuZm9yY2VQdXNoKCk7XG4gICAgICBlbHNlIGlmIChtb2RlID09PSAncHVsbCcpIHJlc3VsdCA9IGF3YWl0IHN5bmNlci5mb3JjZVB1bGwoKTtcbiAgICAgIGVsc2UgcmVzdWx0ID0gYXdhaXQgc3luY2VyLnNtYXJ0U3luYygpO1xuXG4gICAgICB0aGlzLmNvbmZsaWN0cy5wdXNoKC4uLnJlc3VsdC5jb25mbGljdHMpO1xuICAgICAgdGhpcy5zZXR0aW5ncy5sYXN0U3luY2VkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgYXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcbiAgICAgIGF3YWl0IHRoaXMuaW5kZXguc2F2ZSgpO1xuXG4gICAgICBjb25zdCBzdW1tYXJ5ID0gYFx1MjE5MSR7cmVzdWx0LnB1c2hlZC5sZW5ndGh9IFx1MjE5MyR7cmVzdWx0LnB1bGxlZC5sZW5ndGh9IFx1RDgzRFx1REREMSR7cmVzdWx0LmRlbGV0ZWQubGVuZ3RofWAgK1xuICAgICAgICAocmVzdWx0LmNvbmZsaWN0cy5sZW5ndGggPyBgIFx1MjZBMFx1RkUwRiR7cmVzdWx0LmNvbmZsaWN0cy5sZW5ndGh9IGNvbmZsaWN0c2AgOiAnJykgK1xuICAgICAgICAocmVzdWx0LmVycm9ycy5sZW5ndGggPyBgIFx1Mjc0QyR7cmVzdWx0LmVycm9ycy5sZW5ndGh9IGVycm9yc2AgOiAnJyk7XG4gICAgICBub3RpY2Uuc2V0TWVzc2FnZShgRG9uZSBcdTIwMTQgJHtzdW1tYXJ5fWApO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBub3RpY2UuaGlkZSgpLCA0MDAwKTtcblxuICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSBjb25zb2xlLmVycm9yKCdbTmVvR0RTeW5jXSBFcnJvcnM6JywgcmVzdWx0LmVycm9ycyk7XG4gICAgICBpZiAocmVzdWx0LmNvbmZsaWN0cy5sZW5ndGgpIG5ldyBOb3RpY2UoYCR7cmVzdWx0LmNvbmZsaWN0cy5sZW5ndGh9IGNvbmZsaWN0KHMpIGRldGVjdGVkYCwgNjAwMCk7XG4gICAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICBub3RpY2Uuc2V0TWVzc2FnZShgU3luYyBlcnJvcjogJHttc2d9YCk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IG5vdGljZS5oaWRlKCksIDUwMDApO1xuICAgICAgY29uc29sZS5lcnJvcignW05lb0dEU3luY10nLCBlcnIpO1xuICAgICAgdGhpcy5zeW5jaW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnVwZGF0ZVN0YXR1cygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEtlZXAgc3luY2luZz10cnVlIGZvciA2MDBtcyBzbyB2YXVsdCBldmVudHMgZmlyZWQgYnkgd3JpdGVMb2NhbC9tb2RpZnlCaW5hcnlcbiAgICAvLyAod2hpY2ggZmlyZSBhc3luY2hyb25vdXNseSkgYXJlIHN0aWxsIHN1cHByZXNzZWQuIFRoZW4gcmUtc2F2ZSBzbmFwc2hvdCB3aXRoXG4gICAgLy8gZnJlc2ggVEZpbGUgc3RhdHMuXG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLnNuYXBzaG90LnNhdmUocCA9PiB0aGlzLmV4Y2x1ZGUocCkpO1xuICAgICAgdm9pZCB0aGlzLnNhdmVTZXR0aW5ncygpLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICB0aGlzLnN5bmNpbmcgPSBmYWxzZTtcbiAgICAgICAgdGhpcy51cGRhdGVTdGF0dXMoKTtcbiAgICAgIH0pO1xuICAgIH0sIDYwMCk7XG4gIH1cblxuICBhc3luYyByZWJ1aWxkSW5kZXgoKSB7XG4gICAgaWYgKHRoaXMuc3luY2luZykgeyBuZXcgTm90aWNlKCdTeW5jIGluIHByb2dyZXNzJyk7IHJldHVybjsgfVxuICAgIHRoaXMuc3luY2luZyA9IHRydWU7XG4gICAgY29uc3Qgbm90aWNlID0gbmV3IE5vdGljZSgnUmVidWlsZGluZyBkcml2ZSBpbmRleFx1MjAyNicsIDApO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLmluZGV4LnJlYnVpbGQobXNnID0+IG5vdGljZS5zZXRNZXNzYWdlKG1zZykpO1xuICAgICAgbm90aWNlLnNldE1lc3NhZ2UoJ0RyaXZlIGluZGV4IHJlYnVpbHQnKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gbm90aWNlLmhpZGUoKSwgMzAwMCk7XG4gICAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICBub3RpY2Uuc2V0TWVzc2FnZShgUmVidWlsZCBmYWlsZWQ6ICR7bXNnfWApO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBub3RpY2UuaGlkZSgpLCA1MDAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5zeW5jaW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnVwZGF0ZVN0YXR1cygpO1xuICAgIH1cbiAgfVxuXG4gIHNob3dDb25mbGljdHMoKSB7IG5ldyBDb25mbGljdE1vZGFsKHRoaXMuYXBwLCB0aGlzKS5vcGVuKCk7IH1cbiAgb3BlblN5bmNNb2RhbCgpIHsgbmV3IFN5bmNNb2RhbCh0aGlzLmFwcCwgdGhpcykub3BlbigpOyB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0YXR1cyBiYXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgdXBkYXRlU3RhdHVzKG92ZXJyaWRlPzogc3RyaW5nKSB7XG4gICAgaWYgKCF0aGlzLnN0YXR1c0VsKSByZXR1cm47XG4gICAgaWYgKG92ZXJyaWRlKSB7IHRoaXMuc3RhdHVzRWwuc2V0VGV4dChgXHUyNjAxICR7b3ZlcnJpZGV9YCk7IHJldHVybjsgfVxuICAgIGNvbnN0IG4gPSBPYmplY3Qua2V5cyh0aGlzLnBlbmRpbmdPcHMpLmxlbmd0aDtcbiAgICBjb25zdCBjID0gdGhpcy5jb25mbGljdHMubGVuZ3RoO1xuICAgIGxldCB0eHQgPSBuID4gMCA/IGBcdTI2MDEgJHtufSBwZW5kaW5nYCA6ICdcdTI2MDEgc3luY2VkJztcbiAgICBpZiAoYyA+IDApIHR4dCArPSBgIFx1MjZBMFx1RkUwRiR7Y31gO1xuICAgIHRoaXMuc3RhdHVzRWwuc2V0VGV4dCh0eHQpO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNldHRpbmdzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHByaXZhdGUgc2F2ZVRpbWVyPzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD47XG4gIGRlYm91bmNlZFNhdmUoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuc2F2ZVRpbWVyKTtcbiAgICB0aGlzLnNhdmVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHRoaXMuc2F2ZVNldHRpbmdzKCk7IH0sIDUwMCk7XG4gIH1cblxuICBhc3luYyBsb2FkU2V0dGluZ3MoKSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCB0aGlzLmxvYWREYXRhKCkgYXMge1xuICAgICAgc2V0dGluZ3M/OiBQYXJ0aWFsPE5lb1NldHRpbmdzPjtcbiAgICAgIHBlbmRpbmdPcHM/OiBQZW5kaW5nT3BzO1xuICAgICAgY29uZmxpY3RzPzogQ29uZmxpY3RSZWNvcmRbXTtcbiAgICAgIHNuYXBzaG90PzogU25hcHNob3Q7XG4gICAgfSB8IG51bGw7XG4gICAgdGhpcy5zZXR0aW5ncyAgID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgc2F2ZWQ/LnNldHRpbmdzID8/IHt9KTtcbiAgICB0aGlzLnBlbmRpbmdPcHMgPSBzYXZlZD8ucGVuZGluZ09wcyA/PyB7fTtcbiAgICB0aGlzLmNvbmZsaWN0cyAgPSBzYXZlZD8uY29uZmxpY3RzID8/IFtdO1xuICAgIGlmICh0aGlzLnNuYXBzaG90KSB0aGlzLnNuYXBzaG90LnNldFJhdyhzYXZlZD8uc25hcHNob3QpO1xuICB9XG5cbiAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEoe1xuICAgICAgc2V0dGluZ3M6ICAgdGhpcy5zZXR0aW5ncyxcbiAgICAgIHBlbmRpbmdPcHM6IHRoaXMucGVuZGluZ09wcyxcbiAgICAgIGNvbmZsaWN0czogIHRoaXMuY29uZmxpY3RzLFxuICAgICAgc25hcHNob3Q6ICAgdGhpcy5zbmFwc2hvdCA/IHRoaXMuc25hcHNob3QuZ2V0QWxsKCkgOiB7fSxcbiAgICB9KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgU3luYyBNb2RhbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY2xhc3MgU3luY01vZGFsIGV4dGVuZHMgTW9kYWwge1xuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcHJpdmF0ZSBwbHVnaW46IE5lb0dEU3luYykgeyBzdXBlcihhcHApOyB9XG5cbiAgb25PcGVuKCkge1xuICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdTeW5jJyB9KTtcblxuICAgIGNvbnN0IHBlbmRpbmcgPSBPYmplY3Qua2V5cyh0aGlzLnBsdWdpbi5wZW5kaW5nT3BzKS5sZW5ndGg7XG4gICAgY29udGVudEVsLmNyZWF0ZUVsKCdwJywgeyB0ZXh0OiBgUGVuZGluZyBvcGVyYXRpb25zOiAke3BlbmRpbmd9YCB9KTtcbiAgICBpZiAocGVuZGluZyA+IDApIHtcbiAgICAgIGNvbnN0IHVsID0gY29udGVudEVsLmNyZWF0ZUVsKCd1bCcpO1xuICAgICAgZm9yIChjb25zdCBbcCwgb3BdIG9mIE9iamVjdC5lbnRyaWVzKHRoaXMucGx1Z2luLnBlbmRpbmdPcHMpLnNsaWNlKDAsIDIwKSkge1xuICAgICAgICB1bC5jcmVhdGVFbCgnbGknLCB7IHRleHQ6IGAke29wfTogJHtwfWAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocGVuZGluZyA+IDIwKSB1bC5jcmVhdGVFbCgnbGknLCB7IHRleHQ6IGBcdTIwMjYgYW5kICR7cGVuZGluZyAtIDIwfSBtb3JlYCB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBidG5Sb3cgPSBjb250ZW50RWwuY3JlYXRlRGl2KHsgY2xzOiAnbmVvZ2RzeW5jLWJ0bi1yb3cnIH0pO1xuICAgIGJ0blJvdy5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnU21hcnQgc3luYycgfSkub25jbGljayAgPSAoKSA9PiB7IHRoaXMuY2xvc2UoKTsgdm9pZCB0aGlzLnBsdWdpbi5ydW5TeW5jKCdzbWFydCcpOyB9O1xuICAgIGJ0blJvdy5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnRm9yY2UgcHVzaCcgfSkub25jbGljayAgID0gKCkgPT4geyB0aGlzLmNsb3NlKCk7IHZvaWQgdGhpcy5wbHVnaW4ucnVuU3luYygncHVzaCcpOyB9O1xuICAgIGJ0blJvdy5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiAnRm9yY2UgcHVsbCcgfSkub25jbGljayAgID0gKCkgPT4geyB0aGlzLmNsb3NlKCk7IHZvaWQgdGhpcy5wbHVnaW4ucnVuU3luYygncHVsbCcpOyB9O1xuICAgIGlmICh0aGlzLnBsdWdpbi5jb25mbGljdHMubGVuZ3RoID4gMCkge1xuICAgICAgYnRuUm93LmNyZWF0ZUVsKCdidXR0b24nLCB7IHRleHQ6IGAke3RoaXMucGx1Z2luLmNvbmZsaWN0cy5sZW5ndGh9IGNvbmZsaWN0c2AgfSlcbiAgICAgICAgLm9uY2xpY2sgPSAoKSA9PiB7IHRoaXMuY2xvc2UoKTsgdGhpcy5wbHVnaW4uc2hvd0NvbmZsaWN0cygpOyB9O1xuICAgIH1cbiAgfVxuXG4gIG9uQ2xvc2UoKSB7IHRoaXMuY29udGVudEVsLmVtcHR5KCk7IH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIENvbmZsaWN0IE1vZGFsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jbGFzcyBDb25mbGljdE1vZGFsIGV4dGVuZHMgTW9kYWwge1xuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcHJpdmF0ZSBwbHVnaW46IE5lb0dEU3luYykgeyBzdXBlcihhcHApOyB9XG5cbiAgb25PcGVuKCkge1xuICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdDb25mbGljdHMnIH0pO1xuICAgIGNvbnN0IGNvbmZsaWN0cyA9IHRoaXMucGx1Z2luLmNvbmZsaWN0cztcbiAgICBpZiAoIWNvbmZsaWN0cy5sZW5ndGgpIHsgY29udGVudEVsLmNyZWF0ZUVsKCdwJywgeyB0ZXh0OiAnTm8gY29uZmxpY3RzLicgfSk7IHJldHVybjsgfVxuICAgIGZvciAoY29uc3QgYyBvZiBjb25mbGljdHMpIHtcbiAgICAgIGNvbnN0IGRpdiA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICduZW9nZHN5bmMtY29uZmxpY3QnIH0pO1xuICAgICAgZGl2LmNyZWF0ZUVsKCdzdHJvbmcnLCB7IHRleHQ6IGMubG9jYWxQYXRoIH0pO1xuICAgICAgZGl2LmNyZWF0ZUVsKCdicicpO1xuICAgICAgZGl2LmNyZWF0ZUVsKCdzbWFsbCcsIHsgdGV4dDogYExvY2FsOiAke25ldyBEYXRlKGMubG9jYWxNdGltZSkudG9Mb2NhbGVTdHJpbmcoKX0gfCBEcml2ZTogJHtuZXcgRGF0ZShjLmRyaXZlTXRpbWUpLnRvTG9jYWxlU3RyaW5nKCl9YCB9KTtcbiAgICAgIGRpdi5jcmVhdGVFbCgnYnInKTtcbiAgICAgIGRpdi5jcmVhdGVFbCgnc21hbGwnLCB7IHRleHQ6IGBEcml2ZSBjb3B5IHNhdmVkIGFzOiAke2MuY29uZmxpY3RDb3B5UGF0aH1gIH0pO1xuICAgIH1cbiAgICBjb250ZW50RWwuY3JlYXRlRWwoJ2hyJyk7XG4gICAgY29udGVudEVsLmNyZWF0ZUVsKCdidXR0b24nLCB7IHRleHQ6ICdDbGVhciBhbGwgY29uZmxpY3RzJyB9KVxuICAgICAgLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIHRoaXMucGx1Z2luLmNvbmZsaWN0cyA9IFtdO1xuICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgdGhpcy5jbG9zZSgpO1xuICAgICAgICBuZXcgTm90aWNlKCdDb25mbGljdHMgY2xlYXJlZCcpO1xuICAgICAgfTtcbiAgfVxuXG4gIG9uQ2xvc2UoKSB7IHRoaXMuY29udGVudEVsLmVtcHR5KCk7IH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIFNldHRpbmdzIFRhYiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY2xhc3MgTmVvU2V0dGluZ3NUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHByaXZhdGUgcGx1Z2luOiBOZW9HRFN5bmMpIHsgc3VwZXIoYXBwLCBwbHVnaW4pOyB9XG5cbiAgZGlzcGxheSgpIHtcbiAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbCkuc2V0SGVhZGluZygpO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnUmVmcmVzaCB0b2tlbicpXG4gICAgICAuc2V0RGVzYygnUmVmcmVzaCB0b2tlbiBmb3IgR29vZ2xlIERyaXZlJylcbiAgICAgIC5hZGRUZXh0KHQgPT4gdC5zZXRQbGFjZWhvbGRlcignMS8vMDVvXHUyMDI2Jykuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MucmVmcmVzaFRva2VuKVxuICAgICAgICAub25DaGFuZ2UoYXN5bmMgdiA9PiB7XG4gICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MucmVmcmVzaFRva2VuID0gdi50cmltKCk7XG4gICAgICAgICAgdGhpcy5wbHVnaW4uZHJpdmUgPSBuZXcgRHJpdmVBcGkodi50cmltKCkpO1xuICAgICAgICAgIGNsZWFyVG9rZW5DYWNoZSgpO1xuICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICB9KSk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdWYXVsdCByb290IGZvbGRlciBJRCcpXG4gICAgICAuc2V0RGVzYygnR29vZ2xlIERyaXZlIGZvbGRlciBJRCB0aGF0IGlzIHRoZSByb290IG9mIHRoaXMgdmF1bHQuIENoYW5nZSByZXF1aXJlcyBwbHVnaW4gcmVsb2FkLicpXG4gICAgICAuYWRkVGV4dCh0ID0+IHtcbiAgICAgICAgdC5pbnB1dEVsLmFkZENsYXNzKCduZW9nZHN5bmMtbW9ub3NwYWNlLWlucHV0Jyk7XG4gICAgICAgIHQuc2V0UGxhY2Vob2xkZXIoJ1Jvb3QgZm9sZGVyIElEJykuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudmF1bHRSb290SWQpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jIHYgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudmF1bHRSb290SWQgPSB2LnRyaW0oKTtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLmluZGV4ID0gbmV3IFBhdGhJbmRleCh0aGlzLnBsdWdpbi5hcHAsIHRoaXMucGx1Z2luLmRyaXZlLCB2LnRyaW0oKSk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5pbmRleC5sb2FkKCk7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnU3luYyBtb2RlJykuc2V0RGVzYygnRGVmYXVsdCBzeW5jIG1vZGUgd2hlbiB1c2luZyByaWJib24gaWNvbicpXG4gICAgICAuYWRkRHJvcGRvd24oZCA9PiBkXG4gICAgICAgIC5hZGRPcHRpb24oJ3NtYXJ0JywgJ1NtYXJ0IChjb25mbGljdCBkZXRlY3QpJylcbiAgICAgICAgLmFkZE9wdGlvbigncHVzaCcsICdGb3JjZSBwdXNoJylcbiAgICAgICAgLmFkZE9wdGlvbigncHVsbCcsICdGb3JjZSBwdWxsJylcbiAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnN5bmNNb2RlKVxuICAgICAgICAub25DaGFuZ2UoYXN5bmMgdiA9PiB7XG4gICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc3luY01vZGUgPSB2IGFzIE5lb1NldHRpbmdzWydzeW5jTW9kZSddO1xuICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICB9KSk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdLZWVwIHJldmlzaW9ucycpLnNldERlc2MoJ0tlZXAgZmlsZSByZXZpc2lvbnMgb24gZHJpdmUgKHZlcnNpb24gaGlzdG9yeSknKVxuICAgICAgLmFkZFRvZ2dsZSh0ID0+IHQuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Mua2VlcFJldmlzaW9ucylcbiAgICAgICAgLm9uQ2hhbmdlKGFzeW5jIHYgPT4geyB0aGlzLnBsdWdpbi5zZXR0aW5ncy5rZWVwUmV2aXNpb25zID0gdjsgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7IH0pKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1BlbmRpbmcgb3BzJykuc2V0RGVzYyhgJHtPYmplY3Qua2V5cyh0aGlzLnBsdWdpbi5wZW5kaW5nT3BzKS5sZW5ndGh9IGZpbGVzIHF1ZXVlZGApXG4gICAgICAuYWRkQnV0dG9uKGIgPT4gYi5zZXRCdXR0b25UZXh0KCdDbGVhciBhbGwnKS5vbkNsaWNrKGFzeW5jICgpID0+IHtcbiAgICAgICAgdGhpcy5wbHVnaW4ucGVuZGluZ09wcyA9IHt9O1xuICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgdGhpcy5wbHVnaW4udXBkYXRlU3RhdHVzKCk7XG4gICAgICAgIHRoaXMuZGlzcGxheSgpO1xuICAgICAgfSkpO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnUmVidWlsZCBkcml2ZSBpbmRleCcpLnNldERlc2MoJ0NyYXdsIGRyaXZlIHZhdWx0IGZyb20gcm9vdCBhbmQgcmVidWlsZCBsb2NhbCBpbmRleCcpXG4gICAgICAuYWRkQnV0dG9uKGIgPT4gYi5zZXRCdXR0b25UZXh0KCdSZWJ1aWxkJykub25DbGljaygoKSA9PiB7IHZvaWQgdGhpcy5wbHVnaW4ucmVidWlsZEluZGV4KCk7IH0pKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKS5zZXROYW1lKCdTdGF0dXMnKS5zZXRIZWFkaW5nKCk7XG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShgTGFzdCBzeW5jOiAke3RoaXMucGx1Z2luLnNldHRpbmdzLmxhc3RTeW5jZWRBdCA/IG5ldyBEYXRlKHRoaXMucGx1Z2luLnNldHRpbmdzLmxhc3RTeW5jZWRBdCkudG9Mb2NhbGVTdHJpbmcoKSA6ICduZXZlcid9YClcbiAgICAgIC5zZXREZXNjKGBDb25mbGljdHM6ICR7dGhpcy5wbHVnaW4uY29uZmxpY3RzLmxlbmd0aH1gKTtcbiAgfVxufVxuIiwgImV4cG9ydCBpbnRlcmZhY2UgTmVvU2V0dGluZ3Mge1xuICByZWZyZXNoVG9rZW46IHN0cmluZztcbiAgdmF1bHRSb290SWQ6IHN0cmluZztcbiAgYXV0aFByb3h5VXJsOiBzdHJpbmc7XG4gIGxhc3RTeW5jZWRBdDogbnVtYmVyO1xuICBjaGFuZ2VzVG9rZW46IHN0cmluZztcbiAgc3luY01vZGU6ICdzbWFydCcgfCAncHVzaCcgfCAncHVsbCc7XG4gIGtlZXBSZXZpc2lvbnM6IGJvb2xlYW47XG4gIGV4Y2x1ZGVQYXRoczogc3RyaW5nW107XG4gIGNvbmN1cnJlbmN5OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBOZW9TZXR0aW5ncyA9IHtcbiAgcmVmcmVzaFRva2VuOiAnJyxcbiAgdmF1bHRSb290SWQ6ICcnLFxuICBhdXRoUHJveHlVcmw6ICdodHRwczovL29nZC5yaWNoYXJkeGlvbmcuY29tL2FwaS9hY2Nlc3MnLFxuICBsYXN0U3luY2VkQXQ6IDAsXG4gIGNoYW5nZXNUb2tlbjogJycsXG4gIHN5bmNNb2RlOiAnc21hcnQnLFxuICBrZWVwUmV2aXNpb25zOiB0cnVlLFxuICBleGNsdWRlUGF0aHM6IFtcbiAgICAnLnNtYXJ0LWVudi8qKicsXG4gICAgJy5zbXRjbXAqJyxcbiAgICAnLmdpdC8qKicsXG4gICAgJyoqLy5EU19TdG9yZScsXG4gICAgJyoqL25vZGVfbW9kdWxlcy8qKicsXG4gICAgJy5uZW9nZHN5bmMvKionLFxuICBdLFxuICBjb25jdXJyZW5jeTogNixcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5kZXhFbnRyeSB7XG4gIGRyaXZlSWQ6IHN0cmluZztcbiAgZHJpdmVNdGltZTogc3RyaW5nO1xuICBzeW5jZWRBdDogbnVtYmVyO1xuICBpc0ZvbGRlcjogYm9vbGVhbjtcbn1cbmV4cG9ydCBpbnRlcmZhY2UgRmlsZUluZGV4IHtcbiAgW2xvY2FsUGF0aDogc3RyaW5nXTogSW5kZXhFbnRyeTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTbmFwc2hvdEVudHJ5IHtcbiAgbXRpbWU6IG51bWJlcjtcbiAgc2l6ZTogbnVtYmVyO1xufVxuZXhwb3J0IGludGVyZmFjZSBTbmFwc2hvdCB7XG4gIFtsb2NhbFBhdGg6IHN0cmluZ106IFNuYXBzaG90RW50cnk7XG59XG5cbmV4cG9ydCB0eXBlIE9wVHlwZSA9ICdjcmVhdGUnIHwgJ21vZGlmeScgfCAnZGVsZXRlJztcbmV4cG9ydCBpbnRlcmZhY2UgUGVuZGluZ09wcyB7XG4gIFtsb2NhbFBhdGg6IHN0cmluZ106IE9wVHlwZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEcml2ZUZpbGVJbmZvIHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICBtaW1lVHlwZTogc3RyaW5nO1xuICBtb2RpZmllZFRpbWU6IHN0cmluZztcbiAgcGFyZW50cz86IHN0cmluZ1tdO1xuICBzaXplPzogc3RyaW5nO1xufVxuXG4vLyBTaGFwZSBvZiBhIHNpbmdsZSBpdGVtIGluIHRoZSBEcml2ZSBDaGFuZ2VzIEFQSSByZXNwb25zZVxuZXhwb3J0IGludGVyZmFjZSBEcml2ZUNoYW5nZSB7XG4gIGZpbGVJZDogc3RyaW5nO1xuICByZW1vdmVkOiBib29sZWFuO1xuICBmaWxlPzoge1xuICAgIGlkOiBzdHJpbmc7XG4gICAgbmFtZTogc3RyaW5nO1xuICAgIG1pbWVUeXBlOiBzdHJpbmc7XG4gICAgbW9kaWZpZWRUaW1lOiBzdHJpbmc7XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJpdmVSZXZpc2lvbiB7XG4gIGlkOiBzdHJpbmc7XG4gIG1vZGlmaWVkVGltZTogc3RyaW5nO1xuICBzaXplPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZsaWN0UmVjb3JkIHtcbiAgbG9jYWxQYXRoOiBzdHJpbmc7XG4gIGxvY2FsTXRpbWU6IG51bWJlcjtcbiAgZHJpdmVNdGltZTogc3RyaW5nO1xuICBjb25mbGljdENvcHlQYXRoOiBzdHJpbmc7XG4gIGRldGVjdGVkQXQ6IG51bWJlcjtcbn1cbiIsICIvKiogR29vZ2xlIERyaXZlIEFQSSB2MyB3cmFwcGVyICovXG5cbmltcG9ydCB7IHJlcXVlc3RVcmwgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBnZXRBY2Nlc3NUb2tlbiB9IGZyb20gJy4vYXV0aCc7XG5pbXBvcnQgeyBEcml2ZUZpbGVJbmZvLCBEcml2ZUNoYW5nZSwgRHJpdmVSZXZpc2lvbiB9IGZyb20gJy4vdHlwZXMnO1xuXG5jb25zdCBCQVNFID0gJ2h0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2RyaXZlL3YzJztcbmNvbnN0IFVQTE9BRCA9ICdodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS91cGxvYWQvZHJpdmUvdjMnO1xuY29uc3QgRk9MREVSX01JTUUgPSAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmZvbGRlcic7XG5cbmFzeW5jIGZ1bmN0aW9uIGRyaXZlUmVxdWVzdChcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHVybDogc3RyaW5nLFxuICBib2R5Pzogc3RyaW5nIHwgQXJyYXlCdWZmZXIsXG4gIGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuICByZWZyZXNoVG9rZW4/OiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGpzb246IHVua25vd247IHRleHQ6IHN0cmluZzsgYXJyYXlCdWZmZXI6IEFycmF5QnVmZmVyIH0+IHtcbiAgY29uc3QgdG9rZW4gPSByZWZyZXNoVG9rZW4gPyBhd2FpdCBnZXRBY2Nlc3NUb2tlbihyZWZyZXNoVG9rZW4pIDogJyc7XG4gIGNvbnN0IHJlc3AgPSBhd2FpdCByZXF1ZXN0VXJsKHtcbiAgICB1cmwsXG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke3Rva2VufWAsIC4uLmhlYWRlcnMgfSxcbiAgICBib2R5LFxuICAgIHRocm93OiBmYWxzZSxcbiAgfSk7XG4gIGlmIChyZXNwLnN0YXR1cyA+PSA0MDApIHtcbiAgICBjb25zdCB0eHQgPSByZXNwLnRleHQuc2xpY2UoMCwgMjAwKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYERyaXZlICR7bWV0aG9kfSAke3VybH0gXHUyMTkyICR7cmVzcC5zdGF0dXN9OiAke3R4dH1gKTtcbiAgfVxuICByZXR1cm4gcmVzcDtcbn1cblxuZXhwb3J0IGNsYXNzIERyaXZlQXBpIHtcbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWZyZXNoVG9rZW46IHN0cmluZykge31cblxuICBwcml2YXRlIHJlcXVlc3QobWV0aG9kOiBzdHJpbmcsIHVybDogc3RyaW5nLCBib2R5Pzogc3RyaW5nIHwgQXJyYXlCdWZmZXIsIGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSB7XG4gICAgcmV0dXJuIGRyaXZlUmVxdWVzdChtZXRob2QsIHVybCwgYm9keSwgaGVhZGVycywgdGhpcy5yZWZyZXNoVG9rZW4pO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEZvbGRlciBvcGVyYXRpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGFzeW5jIGxpc3RDaGlsZHJlbihmb2xkZXJJZDogc3RyaW5nKTogUHJvbWlzZTxEcml2ZUZpbGVJbmZvW10+IHtcbiAgICBjb25zdCByZXN1bHRzOiBEcml2ZUZpbGVJbmZvW10gPSBbXTtcbiAgICBsZXQgcGFnZVRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgZG8ge1xuICAgICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7XG4gICAgICAgIHE6IGAnJHtmb2xkZXJJZH0nIGluIHBhcmVudHMgYW5kIHRyYXNoZWQ9ZmFsc2VgLFxuICAgICAgICBmaWVsZHM6ICduZXh0UGFnZVRva2VuLGZpbGVzKGlkLG5hbWUsbWltZVR5cGUsbW9kaWZpZWRUaW1lLHNpemUpJyxcbiAgICAgICAgcGFnZVNpemU6ICcxMDAwJyxcbiAgICAgIH0pO1xuICAgICAgaWYgKHBhZ2VUb2tlbikgcGFyYW1zLnNldCgncGFnZVRva2VuJywgcGFnZVRva2VuKTtcbiAgICAgIGNvbnN0IHJlc3AgPSBhd2FpdCB0aGlzLnJlcXVlc3QoJ0dFVCcsIGAke0JBU0V9L2ZpbGVzPyR7cGFyYW1zfWApO1xuICAgICAgY29uc3QgZGF0YSA9IHJlc3AuanNvbiBhcyB7IGZpbGVzPzogRHJpdmVGaWxlSW5mb1tdOyBuZXh0UGFnZVRva2VuPzogc3RyaW5nIH07XG4gICAgICByZXN1bHRzLnB1c2goLi4uKGRhdGEuZmlsZXMgPz8gW10pKTtcbiAgICAgIHBhZ2VUb2tlbiA9IGRhdGEubmV4dFBhZ2VUb2tlbjtcbiAgICB9IHdoaWxlIChwYWdlVG9rZW4pO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9XG5cbiAgYXN5bmMgY3JlYXRlRm9sZGVyKG5hbWU6IHN0cmluZywgcGFyZW50SWQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgcmVzcCA9IGF3YWl0IHRoaXMucmVxdWVzdChcbiAgICAgICdQT1NUJyxcbiAgICAgIGAke0JBU0V9L2ZpbGVzP2ZpZWxkcz1pZGAsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IG5hbWUsIG1pbWVUeXBlOiBGT0xERVJfTUlNRSwgcGFyZW50czogW3BhcmVudElkXSB9KSxcbiAgICAgIHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LFxuICAgICk7XG4gICAgY29uc3QgeyBpZCB9ID0gcmVzcC5qc29uIGFzIHsgaWQ6IHN0cmluZyB9O1xuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBGaWxlIG9wZXJhdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgYXN5bmMgdXBsb2FkRmlsZShcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgcGFyZW50SWQ6IHN0cmluZyxcbiAgICBjb250ZW50OiBBcnJheUJ1ZmZlcixcbiAgICBtaW1lVHlwZTogc3RyaW5nLFxuICAgIG1vZGlmaWVkVGltZTogc3RyaW5nLFxuICAgIGtlZXBSZXZpc2lvbiA9IGZhbHNlLFxuICApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IGJvdW5kYXJ5ID0gJ25lb2dkc3luY19ib3VuZGFyeSc7XG4gICAgY29uc3QgbWV0YSA9IEpTT04uc3RyaW5naWZ5KHsgbmFtZSwgcGFyZW50czogW3BhcmVudElkXSwgbW9kaWZpZWRUaW1lIH0pO1xuICAgIGNvbnN0IGJvZHkgPSBidWlsZE11bHRpcGFydChib3VuZGFyeSwgbWV0YSwgY29udGVudCwgbWltZVR5cGUpO1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyB1cGxvYWRUeXBlOiAnbXVsdGlwYXJ0JywgZmllbGRzOiAnaWQnIH0pO1xuICAgIGlmIChrZWVwUmV2aXNpb24pIHBhcmFtcy5zZXQoJ2tlZXBSZXZpc2lvbkZvcmV2ZXInLCAndHJ1ZScpO1xuICAgIGNvbnN0IHJlc3AgPSBhd2FpdCB0aGlzLnJlcXVlc3QoXG4gICAgICAnUE9TVCcsXG4gICAgICBgJHtVUExPQUR9L2ZpbGVzPyR7cGFyYW1zfWAsXG4gICAgICBib2R5LmJ1ZmZlcixcbiAgICAgIHsgJ0NvbnRlbnQtVHlwZSc6IGBtdWx0aXBhcnQvcmVsYXRlZDsgYm91bmRhcnk9JHtib3VuZGFyeX1gIH0sXG4gICAgKTtcbiAgICBjb25zdCB7IGlkIH0gPSByZXNwLmpzb24gYXMgeyBpZDogc3RyaW5nIH07XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgYXN5bmMgdXBkYXRlRmlsZShcbiAgICBkcml2ZUlkOiBzdHJpbmcsXG4gICAgY29udGVudDogQXJyYXlCdWZmZXIsXG4gICAgbWltZVR5cGU6IHN0cmluZyxcbiAgICBtb2RpZmllZFRpbWU6IHN0cmluZyxcbiAgICBrZWVwUmV2aXNpb24gPSBmYWxzZSxcbiAgKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBib3VuZGFyeSA9ICduZW9nZHN5bmNfYm91bmRhcnknO1xuICAgIGNvbnN0IG1ldGEgPSBKU09OLnN0cmluZ2lmeSh7IG1vZGlmaWVkVGltZSB9KTtcbiAgICBjb25zdCBib2R5ID0gYnVpbGRNdWx0aXBhcnQoYm91bmRhcnksIG1ldGEsIGNvbnRlbnQsIG1pbWVUeXBlKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgdXBsb2FkVHlwZTogJ211bHRpcGFydCcsIGZpZWxkczogJ2lkJyB9KTtcbiAgICBpZiAoa2VlcFJldmlzaW9uKSBwYXJhbXMuc2V0KCdrZWVwUmV2aXNpb25Gb3JldmVyJywgJ3RydWUnKTtcbiAgICBjb25zdCByZXNwID0gYXdhaXQgdGhpcy5yZXF1ZXN0KFxuICAgICAgJ1BBVENIJyxcbiAgICAgIGAke1VQTE9BRH0vZmlsZXMvJHtkcml2ZUlkfT8ke3BhcmFtc31gLFxuICAgICAgYm9keS5idWZmZXIsXG4gICAgICB7ICdDb250ZW50LVR5cGUnOiBgbXVsdGlwYXJ0L3JlbGF0ZWQ7IGJvdW5kYXJ5PSR7Ym91bmRhcnl9YCB9LFxuICAgICk7XG4gICAgY29uc3QgeyBpZCB9ID0gcmVzcC5qc29uIGFzIHsgaWQ6IHN0cmluZyB9O1xuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIGFzeW5jIHJlbmFtZUZpbGUoZHJpdmVJZDogc3RyaW5nLCBuZXdOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLnJlcXVlc3QoXG4gICAgICAnUEFUQ0gnLFxuICAgICAgYCR7QkFTRX0vZmlsZXMvJHtkcml2ZUlkfT9maWVsZHM9aWRgLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyBuYW1lOiBuZXdOYW1lIH0pLFxuICAgICAgeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIGRlbGV0ZUZpbGUoZHJpdmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5yZXF1ZXN0KCdERUxFVEUnLCBgJHtCQVNFfS9maWxlcy8ke2RyaXZlSWR9YCk7XG4gIH1cblxuICBhc3luYyBkb3dubG9hZEZpbGUoZHJpdmVJZDogc3RyaW5nKTogUHJvbWlzZTxBcnJheUJ1ZmZlcj4ge1xuICAgIGNvbnN0IHJlc3AgPSBhd2FpdCB0aGlzLnJlcXVlc3QoJ0dFVCcsIGAke0JBU0V9L2ZpbGVzLyR7ZHJpdmVJZH0/YWx0PW1lZGlhYCk7XG4gICAgcmV0dXJuIHJlc3AuYXJyYXlCdWZmZXI7XG4gIH1cblxuICBhc3luYyBnZXRGaWxlTWV0YShkcml2ZUlkOiBzdHJpbmcpOiBQcm9taXNlPERyaXZlRmlsZUluZm8+IHtcbiAgICBjb25zdCByZXNwID0gYXdhaXQgdGhpcy5yZXF1ZXN0KCdHRVQnLCBgJHtCQVNFfS9maWxlcy8ke2RyaXZlSWR9P2ZpZWxkcz1pZCxuYW1lLG1pbWVUeXBlLG1vZGlmaWVkVGltZSxwYXJlbnRzLHNpemVgKTtcbiAgICByZXR1cm4gcmVzcC5qc29uIGFzIERyaXZlRmlsZUluZm87XG4gIH1cblxuICBhc3luYyBnZXRDaGFuZ2VzKHBhZ2VUb2tlbjogc3RyaW5nKTogUHJvbWlzZTx7IGNoYW5nZXM6IERyaXZlQ2hhbmdlW107IG5ld1Rva2VuOiBzdHJpbmcgfT4ge1xuICAgIGNvbnN0IGNoYW5nZXM6IERyaXZlQ2hhbmdlW10gPSBbXTtcbiAgICBsZXQgdG9rZW4gPSBwYWdlVG9rZW47XG4gICAgd2hpbGUgKHRva2VuKSB7XG4gICAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHtcbiAgICAgICAgcGFnZVRva2VuOiB0b2tlbixcbiAgICAgICAgcGFnZVNpemU6ICcxMDAwJyxcbiAgICAgICAgaW5jbHVkZVJlbW92ZWQ6ICd0cnVlJyxcbiAgICAgICAgZmllbGRzOiAnbmV4dFBhZ2VUb2tlbixuZXdTdGFydFBhZ2VUb2tlbixjaGFuZ2VzKGZpbGVJZCxyZW1vdmVkLGZpbGUoaWQsbmFtZSxtaW1lVHlwZSxtb2RpZmllZFRpbWUpKScsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHJlc3AgPSBhd2FpdCB0aGlzLnJlcXVlc3QoJ0dFVCcsIGAke0JBU0V9L2NoYW5nZXM/JHtwYXJhbXN9YCk7XG4gICAgICBjb25zdCBkYXRhID0gcmVzcC5qc29uIGFzIHtcbiAgICAgICAgY2hhbmdlcz86IERyaXZlQ2hhbmdlW107XG4gICAgICAgIG5leHRQYWdlVG9rZW4/OiBzdHJpbmc7XG4gICAgICAgIG5ld1N0YXJ0UGFnZVRva2VuPzogc3RyaW5nO1xuICAgICAgfTtcbiAgICAgIGNoYW5nZXMucHVzaCguLi4oZGF0YS5jaGFuZ2VzID8/IFtdKSk7XG4gICAgICB0b2tlbiA9IGRhdGEubmV4dFBhZ2VUb2tlbiA/PyAnJztcbiAgICAgIGlmIChkYXRhLm5ld1N0YXJ0UGFnZVRva2VuKSB7XG4gICAgICAgIHJldHVybiB7IGNoYW5nZXMsIG5ld1Rva2VuOiBkYXRhLm5ld1N0YXJ0UGFnZVRva2VuIH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IGNoYW5nZXMsIG5ld1Rva2VuOiBwYWdlVG9rZW4gfTtcbiAgfVxuXG4gIGFzeW5jIGdldFN0YXJ0UGFnZVRva2VuKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgY29uc3QgcmVzcCA9IGF3YWl0IHRoaXMucmVxdWVzdCgnR0VUJywgYCR7QkFTRX0vY2hhbmdlcy9zdGFydFBhZ2VUb2tlbmApO1xuICAgIGNvbnN0IHsgc3RhcnRQYWdlVG9rZW4gfSA9IHJlc3AuanNvbiBhcyB7IHN0YXJ0UGFnZVRva2VuOiBzdHJpbmcgfTtcbiAgICByZXR1cm4gc3RhcnRQYWdlVG9rZW47XG4gIH1cblxuICBhc3luYyBsaXN0UmV2aXNpb25zKGRyaXZlSWQ6IHN0cmluZyk6IFByb21pc2U8RHJpdmVSZXZpc2lvbltdPiB7XG4gICAgY29uc3QgcmVzcCA9IGF3YWl0IHRoaXMucmVxdWVzdCgnR0VUJywgYCR7QkFTRX0vZmlsZXMvJHtkcml2ZUlkfS9yZXZpc2lvbnM/ZmllbGRzPXJldmlzaW9ucyhpZCxtb2RpZmllZFRpbWUsc2l6ZSlgKTtcbiAgICBjb25zdCBkYXRhID0gcmVzcC5qc29uIGFzIHsgcmV2aXNpb25zPzogRHJpdmVSZXZpc2lvbltdIH07XG4gICAgcmV0dXJuIGRhdGEucmV2aXNpb25zID8/IFtdO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZE11bHRpcGFydChib3VuZGFyeTogc3RyaW5nLCBtZXRhOiBzdHJpbmcsIGNvbnRlbnQ6IEFycmF5QnVmZmVyLCBtaW1lOiBzdHJpbmcpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgZW5jID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gIGNvbnN0IGhlYWRlciA9IGVuYy5lbmNvZGUoXG4gICAgYC0tJHtib3VuZGFyeX1cXHJcXG5Db250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9VVRGLThcXHJcXG5cXHJcXG4ke21ldGF9XFxyXFxuYCArXG4gICAgYC0tJHtib3VuZGFyeX1cXHJcXG5Db250ZW50LVR5cGU6ICR7bWltZX1cXHJcXG5cXHJcXG5gLFxuICApO1xuICBjb25zdCBmb290ZXIgPSBlbmMuZW5jb2RlKGBcXHJcXG4tLSR7Ym91bmRhcnl9LS1gKTtcbiAgY29uc3QgYm9keSA9IG5ldyBVaW50OEFycmF5KGhlYWRlci5ieXRlTGVuZ3RoICsgY29udGVudC5ieXRlTGVuZ3RoICsgZm9vdGVyLmJ5dGVMZW5ndGgpO1xuICBib2R5LnNldChoZWFkZXIsIDApO1xuICBib2R5LnNldChuZXcgVWludDhBcnJheShjb250ZW50KSwgaGVhZGVyLmJ5dGVMZW5ndGgpO1xuICBib2R5LnNldChmb290ZXIsIGhlYWRlci5ieXRlTGVuZ3RoICsgY29udGVudC5ieXRlTGVuZ3RoKTtcbiAgcmV0dXJuIGJvZHk7XG59XG4iLCAiLyoqIEF1dGggbW9kdWxlIFx1MjAxNCB0b2tlbiByZWZyZXNoIHZpYSBjb25maWd1cmFibGUgcHJveHkgKi9cblxuaW1wb3J0IHsgcmVxdWVzdFVybCB9IGZyb20gJ29ic2lkaWFuJztcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfUFJPWFlfVVJMID0gJ2h0dHBzOi8vb2dkLnJpY2hhcmR4aW9uZy5jb20vYXBpL2FjY2Vzcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWNjZXNzVG9rZW4ge1xuICB0b2tlbjogc3RyaW5nO1xuICBleHBpcmVzQXQ6IG51bWJlcjtcbn1cblxubGV0IGNhY2hlZDogQWNjZXNzVG9rZW4gfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFjY2Vzc1Rva2VuKFxuICByZWZyZXNoVG9rZW46IHN0cmluZyxcbiAgcHJveHlVcmw6IHN0cmluZyA9IERFRkFVTFRfUFJPWFlfVVJMLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgaWYgKGNhY2hlZCAmJiBEYXRlLm5vdygpIDwgY2FjaGVkLmV4cGlyZXNBdCAtIDYwXzAwMCkge1xuICAgIHJldHVybiBjYWNoZWQudG9rZW47XG4gIH1cbiAgY29uc3QgcmVzcCA9IGF3YWl0IHJlcXVlc3RVcmwoe1xuICAgIHVybDogcHJveHlVcmwsXG4gICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyByZWZyZXNoX3Rva2VuOiByZWZyZXNoVG9rZW4gfSksXG4gICAgdGhyb3c6IGZhbHNlLFxuICB9KTtcbiAgaWYgKHJlc3Auc3RhdHVzID49IDQwMCkgdGhyb3cgbmV3IEVycm9yKGBBdXRoIGZhaWxlZDogJHtyZXNwLnN0YXR1c31gKTtcbiAgY29uc3QgeyBhY2Nlc3NfdG9rZW4sIGV4cGlyZXNfaW4gfSA9IHJlc3AuanNvbiBhcyB7IGFjY2Vzc190b2tlbjogc3RyaW5nOyBleHBpcmVzX2luOiBudW1iZXIgfTtcbiAgY2FjaGVkID0geyB0b2tlbjogYWNjZXNzX3Rva2VuLCBleHBpcmVzQXQ6IERhdGUubm93KCkgKyBleHBpcmVzX2luICogMTAwMCB9O1xuICByZXR1cm4gY2FjaGVkLnRva2VuO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJUb2tlbkNhY2hlKCkge1xuICBjYWNoZWQgPSBudWxsO1xufVxuIiwgIi8qKlxuICogUGF0aEluZGV4IFx1MjAxNCBsaWdodHdlaWdodCBsb2NhbFBhdGhcdTIxOTJkcml2ZUlkIGNhY2hlLlxuICogU3RvcmVkIGluIC5uZW9nZHN5bmMvaW5kZXguZGIgKEpTT04pLCBzZXBhcmF0ZSBmcm9tIGRhdGEuanNvbi5cbiAqIE9uIGNhY2hlIG1pc3MsIG5hdmlnYXRlcyBEcml2ZSBieSBwYXRoIGhpZXJhcmNoeSBmcm9tIHZhdWx0Um9vdElkLlxuICovXG5cbmltcG9ydCB7IERyaXZlQXBpIH0gZnJvbSAnLi9kcml2ZUFwaSc7XG5pbXBvcnQgeyBGaWxlSW5kZXgsIEluZGV4RW50cnkgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IEFwcCwgbm9ybWFsaXplUGF0aCB9IGZyb20gJ29ic2lkaWFuJztcblxuY29uc3QgSU5ERVhfUEFUSCA9ICcubmVvZ2RzeW5jL2luZGV4LmRiJztcbmNvbnN0IEZPTERFUl9NSU1FID0gJ2FwcGxpY2F0aW9uL3ZuZC5nb29nbGUtYXBwcy5mb2xkZXInO1xuXG5leHBvcnQgY2xhc3MgUGF0aEluZGV4IHtcbiAgcHJpdmF0ZSBpbmRleDogRmlsZUluZGV4ID0ge307XG4gIHByaXZhdGUgZGlydHkgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIGFwcDogQXBwLFxuICAgIHByaXZhdGUgZHJpdmU6IERyaXZlQXBpLFxuICAgIHByaXZhdGUgdmF1bHRSb290SWQ6IHN0cmluZyxcbiAgKSB7fVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQZXJzaXN0ZW5jZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBhc3luYyBsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXcgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5hZGFwdGVyLnJlYWQobm9ybWFsaXplUGF0aChJTkRFWF9QQVRIKSk7XG4gICAgICB0aGlzLmluZGV4ID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhpcy5pbmRleCA9IHt9O1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHNhdmUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCF0aGlzLmRpcnR5KSByZXR1cm47XG4gICAgYXdhaXQgZW5zdXJlRGlyKHRoaXMuYXBwLCAnLm5lb2dkc3luYycpO1xuICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LmFkYXB0ZXIud3JpdGUobm9ybWFsaXplUGF0aChJTkRFWF9QQVRIKSwgSlNPTi5zdHJpbmdpZnkodGhpcy5pbmRleCwgbnVsbCwgMikpO1xuICAgIHRoaXMuZGlydHkgPSBmYWxzZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBDb3JlIGxvb2t1cHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgZ2V0KGxvY2FsUGF0aDogc3RyaW5nKTogSW5kZXhFbnRyeSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuaW5kZXhbbG9jYWxQYXRoXTtcbiAgfVxuXG4gIHNldChsb2NhbFBhdGg6IHN0cmluZywgZW50cnk6IEluZGV4RW50cnkpOiB2b2lkIHtcbiAgICB0aGlzLmluZGV4W2xvY2FsUGF0aF0gPSBlbnRyeTtcbiAgICB0aGlzLmRpcnR5ID0gdHJ1ZTtcbiAgfVxuXG4gIGRlbGV0ZShsb2NhbFBhdGg6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICh0aGlzLmluZGV4W2xvY2FsUGF0aF0pIHtcbiAgICAgIGRlbGV0ZSB0aGlzLmluZGV4W2xvY2FsUGF0aF07XG4gICAgICB0aGlzLmRpcnR5ID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICByZW5hbWUob2xkUGF0aDogc3RyaW5nLCBuZXdQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMuaW5kZXhbb2xkUGF0aF07XG4gICAgaWYgKGVudHJ5KSB7XG4gICAgICB0aGlzLmluZGV4W25ld1BhdGhdID0gZW50cnk7XG4gICAgICBkZWxldGUgdGhpcy5pbmRleFtvbGRQYXRoXTtcbiAgICAgIHRoaXMuZGlydHkgPSB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIGFsbFBhdGhzKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5pbmRleCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgRHJpdmUgcGF0aCBuYXZpZ2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIGEgbG9jYWwgcGF0aCB0byBpdHMgRHJpdmUgZm9sZGVyIElELlxuICAgKiBDcmVhdGVzIGZvbGRlcnMgb24gRHJpdmUgaWYgdGhleSBkb24ndCBleGlzdCB5ZXQuXG4gICAqIENhY2hlcyBmb2xkZXIgSURzIGluIHRoZSBpbmRleC5cbiAgICovXG4gIGFzeW5jIHJlc29sdmVQYXJlbnRGb2xkZXIobG9jYWxQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IHBhcnRzID0gbG9jYWxQYXRoLnNwbGl0KCcvJyk7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMSkgcmV0dXJuIHRoaXMudmF1bHRSb290SWQ7XG4gICAgY29uc3QgcGFyZW50UGF0aCA9IHBhcnRzLnNsaWNlKDAsIC0xKS5qb2luKCcvJyk7XG4gICAgcmV0dXJuIHRoaXMucmVzb2x2ZUZvbGRlcihwYXJlbnRQYXRoKTtcbiAgfVxuXG4gIGFzeW5jIHJlc29sdmVGb2xkZXIobG9jYWxQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IGNhY2hlZCA9IHRoaXMuaW5kZXhbbG9jYWxQYXRoXTtcbiAgICBpZiAoY2FjaGVkPy5pc0ZvbGRlcikgcmV0dXJuIGNhY2hlZC5kcml2ZUlkO1xuXG4gICAgY29uc3QgcGFydHMgPSBsb2NhbFBhdGguc3BsaXQoJy8nKTtcbiAgICBsZXQgY3VycmVudElkID0gdGhpcy52YXVsdFJvb3RJZDtcbiAgICBsZXQgYnVpbHRQYXRoID0gJyc7XG5cbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcbiAgICAgIGJ1aWx0UGF0aCA9IGJ1aWx0UGF0aCA/IGAke2J1aWx0UGF0aH0vJHtwYXJ0fWAgOiBwYXJ0O1xuICAgICAgY29uc3QgY2FjaGVkUGFydCA9IHRoaXMuaW5kZXhbYnVpbHRQYXRoXTtcbiAgICAgIGlmIChjYWNoZWRQYXJ0Py5pc0ZvbGRlcikge1xuICAgICAgICBjdXJyZW50SWQgPSBjYWNoZWRQYXJ0LmRyaXZlSWQ7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gTG9vayBmb3IgZm9sZGVyIGFtb25nIGNoaWxkcmVuIG9mIGN1cnJlbnRcbiAgICAgIGNvbnN0IGNoaWxkcmVuID0gYXdhaXQgdGhpcy5kcml2ZS5saXN0Q2hpbGRyZW4oY3VycmVudElkKTtcbiAgICAgIGNvbnN0IGZvdW5kID0gY2hpbGRyZW4uZmluZChjID0+IGMubmFtZSA9PT0gcGFydCAmJiBjLm1pbWVUeXBlID09PSBGT0xERVJfTUlNRSk7XG4gICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgdGhpcy5zZXQoYnVpbHRQYXRoLCB7XG4gICAgICAgICAgZHJpdmVJZDogZm91bmQuaWQsXG4gICAgICAgICAgZHJpdmVNdGltZTogZm91bmQubW9kaWZpZWRUaW1lLFxuICAgICAgICAgIHN5bmNlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICAgIGlzRm9sZGVyOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgICAgY3VycmVudElkID0gZm91bmQuaWQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBDcmVhdGUgdGhlIGZvbGRlclxuICAgICAgICBjb25zdCBuZXdJZCA9IGF3YWl0IHRoaXMuZHJpdmUuY3JlYXRlRm9sZGVyKHBhcnQsIGN1cnJlbnRJZCk7XG4gICAgICAgIHRoaXMuc2V0KGJ1aWx0UGF0aCwge1xuICAgICAgICAgIGRyaXZlSWQ6IG5ld0lkLFxuICAgICAgICAgIGRyaXZlTXRpbWU6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICBzeW5jZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICBpc0ZvbGRlcjogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGN1cnJlbnRJZCA9IG5ld0lkO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gY3VycmVudElkO1xuICB9XG5cbiAgLyoqXG4gICAqIEZpbmQgYSBmaWxlIG9uIERyaXZlIGJ5IG5hdmlnYXRpbmcgZnJvbSB2YXVsdFJvb3QgYnkgcGF0aC5cbiAgICogUmV0dXJucyBudWxsIGlmIG5vdCBmb3VuZC5cbiAgICovXG4gIGFzeW5jIGZpbmRPbkRyaXZlKGxvY2FsUGF0aDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgY29uc3QgcGFydHMgPSBsb2NhbFBhdGguc3BsaXQoJy8nKTtcbiAgICBjb25zdCBmaWxlTmFtZSA9IHBhcnRzW3BhcnRzLmxlbmd0aCAtIDFdO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJlbnRJZCA9IGF3YWl0IHRoaXMucmVzb2x2ZVBhcmVudEZvbGRlcihsb2NhbFBhdGgpO1xuICAgICAgY29uc3QgY2hpbGRyZW4gPSBhd2FpdCB0aGlzLmRyaXZlLmxpc3RDaGlsZHJlbihwYXJlbnRJZCk7XG4gICAgICAvLyBQcmVmZXIgaW5kZXgta25vd24gSUQgdG8gYXZvaWQgZHVwbGljYXRlc1xuICAgICAgY29uc3QgY2FjaGVkID0gdGhpcy5pbmRleFtsb2NhbFBhdGhdO1xuICAgICAgaWYgKGNhY2hlZCAmJiAhY2FjaGVkLmlzRm9sZGVyKSB7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gY2hpbGRyZW4uZmluZChjID0+IGMuaWQgPT09IGNhY2hlZC5kcml2ZUlkKTtcbiAgICAgICAgaWYgKG1hdGNoKSByZXR1cm4gbWF0Y2guaWQ7XG4gICAgICB9XG4gICAgICAvLyBGYWxsIGJhY2sgdG8gbmFtZSBtYXRjaCAocGljayBtb3N0IHJlY2VudGx5IG1vZGlmaWVkIGlmIGR1cGxpY2F0ZXMpXG4gICAgICBjb25zdCBtYXRjaGVzID0gY2hpbGRyZW4uZmlsdGVyKGMgPT4gYy5uYW1lID09PSBmaWxlTmFtZSAmJiBjLm1pbWVUeXBlICE9PSBGT0xERVJfTUlNRSk7XG4gICAgICBpZiAoIW1hdGNoZXMubGVuZ3RoKSByZXR1cm4gbnVsbDtcbiAgICAgIG1hdGNoZXMuc29ydCgoYSwgYikgPT4gKGEubW9kaWZpZWRUaW1lID4gYi5tb2RpZmllZFRpbWUgPyAtMSA6IDEpKTtcbiAgICAgIHJldHVybiBtYXRjaGVzWzBdLmlkO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlYnVpbGQgdGhlIGZ1bGwgaW5kZXggYnkgY3Jhd2xpbmcgRHJpdmUgZnJvbSB2YXVsdFJvb3QuXG4gICAqIFVzZWQgZm9yIGluaXRpYWwgc2V0dXAgb3IgcmVwYWlyLlxuICAgKi9cbiAgYXN5bmMgcmVidWlsZChvblByb2dyZXNzPzogKG1zZzogc3RyaW5nKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5pbmRleCA9IHt9O1xuICAgIGF3YWl0IHRoaXMuY3Jhd2wodGhpcy52YXVsdFJvb3RJZCwgJycsIG9uUHJvZ3Jlc3MpO1xuICAgIHRoaXMuZGlydHkgPSB0cnVlO1xuICAgIGF3YWl0IHRoaXMuc2F2ZSgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBjcmF3bChmb2xkZXJJZDogc3RyaW5nLCBwcmVmaXg6IHN0cmluZywgb25Qcm9ncmVzcz86IChtc2c6IHN0cmluZykgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGNoaWxkcmVuID0gYXdhaXQgdGhpcy5kcml2ZS5saXN0Q2hpbGRyZW4oZm9sZGVySWQpO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHtcbiAgICAgIGNvbnN0IHBhdGggPSBwcmVmaXggPyBgJHtwcmVmaXh9LyR7Y2hpbGQubmFtZX1gIDogY2hpbGQubmFtZTtcbiAgICAgIGNvbnN0IGlzRm9sZGVyID0gY2hpbGQubWltZVR5cGUgPT09IEZPTERFUl9NSU1FO1xuICAgICAgdGhpcy5pbmRleFtwYXRoXSA9IHtcbiAgICAgICAgZHJpdmVJZDogY2hpbGQuaWQsXG4gICAgICAgIGRyaXZlTXRpbWU6IGNoaWxkLm1vZGlmaWVkVGltZSxcbiAgICAgICAgc3luY2VkQXQ6IERhdGUubm93KCksXG4gICAgICAgIGlzRm9sZGVyLFxuICAgICAgfTtcbiAgICAgIGlmIChvblByb2dyZXNzKSBvblByb2dyZXNzKHBhdGgpO1xuICAgICAgaWYgKGlzRm9sZGVyKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuY3Jhd2woY2hpbGQuaWQsIHBhdGgsIG9uUHJvZ3Jlc3MpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgaGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGlyKGFwcDogQXBwLCBwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm9ybSA9IG5vcm1hbGl6ZVBhdGgocGF0aCk7XG4gIGlmICghKGF3YWl0IGFwcC52YXVsdC5hZGFwdGVyLmV4aXN0cyhub3JtKSkpIHtcbiAgICBhd2FpdCBhcHAudmF1bHQuYWRhcHRlci5ta2Rpcihub3JtKTtcbiAgfVxufVxuIiwgIi8qKlxuICogVmF1bHRTbmFwc2hvdCBcdTIwMTQgcmVjb3JkcyB2YXVsdCBmaWxlIHN0YXRzIGFmdGVyIGVhY2ggc3luYy5cbiAqIFN0b3JlZCBpbiBkYXRhLmpzb24gKHZpYSBwbHVnaW4uc2F2ZVNldHRpbmdzL2xvYWRTZXR0aW5ncyksIG5vdCBpbiBhIHNlcGFyYXRlIGZpbGUuXG4gKiBPbiBzdGFydHVwLCBkaWZmIGN1cnJlbnQgdmF1bHQgYWdhaW5zdCBzbmFwc2hvdCB0byBkZXRlY3Qgb2ZmbGluZSBjaGFuZ2VzLlxuICpcbiAqIEtleSBkZXNpZ24gZGVjaXNpb25zOlxuICogLSBsb2FkKCkgaXMgYSBuby1vcDsgZGF0YSBpcyBpbmplY3RlZCB2aWEgc2V0UmF3KCkgZnJvbSBsb2FkU2V0dGluZ3MoKVxuICogLSBzYXZlKCkgdXBkYXRlcyBpbi1tZW1vcnkgc3RhdGUgb25seTsgY2FsbGVyIG11c3Qgc2F2ZVNldHRpbmdzKCkgdG8gcGVyc2lzdFxuICogLSBzZXRSYXcoKSBwdXJnZXMgY29uZmlnRGlyIGVudHJpZXMgKHRoZXkncmUgbm90IGluIHZhdWx0LmdldEZpbGVzKCkpXG4gKi9cblxuaW1wb3J0IHsgQXBwIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgU25hcHNob3QsIFBlbmRpbmdPcHMgfSBmcm9tICcuL3R5cGVzJztcblxuZXhwb3J0IGNsYXNzIFZhdWx0U25hcHNob3Qge1xuICBwcml2YXRlIHNuYXBzaG90OiBTbmFwc2hvdCA9IHt9O1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgYXBwOiBBcHApIHt9XG5cbiAgLyoqIEluamVjdGVkIGJ5IHBsdWdpbi5sb2FkU2V0dGluZ3MoKSBcdTIwMTQgcHVyZ2VzIGNvbmZpZyBkaXIgZW50cmllcyBkZWZlbnNpdmVseS4gKi9cbiAgc2V0UmF3KGRhdGE6IFNuYXBzaG90IHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gICAgY29uc3QgcmF3ID0gZGF0YSB8fCB7fTtcbiAgICBjb25zdCBjb25maWdEaXIgPSB0aGlzLmFwcC52YXVsdC5jb25maWdEaXI7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocmF3KSkge1xuICAgICAgaWYgKGtleS5zdGFydHNXaXRoKGNvbmZpZ0RpcikpIGRlbGV0ZSAocmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrZXldO1xuICAgIH1cbiAgICB0aGlzLnNuYXBzaG90ID0gcmF3O1xuICB9XG5cbiAgLyoqIE5vLW9wOiBkYXRhIGlzIGluamVjdGVkIHZpYSBzZXRSYXcoKSBmcm9tIGxvYWRTZXR0aW5ncygpLiAqL1xuICBsb2FkKCk6IHZvaWQge31cblxuICAvKipcbiAgICogUmVidWlsZCBzbmFwc2hvdCBmcm9tIGN1cnJlbnQgdmF1bHQgc3RhdGUuXG4gICAqIFVwZGF0ZXMgaW4tbWVtb3J5IHNuYXBzaG90IG9ubHk7IGNhbGxlciBtdXN0IGNhbGwgc2F2ZVNldHRpbmdzKCkgdG8gcGVyc2lzdC5cbiAgICovXG4gIHNhdmUoZXhjbHVkZTogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbik6IHZvaWQge1xuICAgIGNvbnN0IGZyZXNoOiBTbmFwc2hvdCA9IHt9O1xuICAgIGNvbnN0IGZpbGVzID0gdGhpcy5hcHAudmF1bHQuZ2V0RmlsZXMoKTtcbiAgICBmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHtcbiAgICAgIGlmICghZXhjbHVkZShmLnBhdGgpKSB7XG4gICAgICAgIGZyZXNoW2YucGF0aF0gPSB7IG10aW1lOiBmLnN0YXQubXRpbWUsIHNpemU6IGYuc3RhdC5zaXplIH07XG4gICAgICB9XG4gICAgfVxuICAgIHRoaXMuc25hcHNob3QgPSBmcmVzaDtcbiAgfVxuXG4gIC8qKlxuICAgKiBEaWZmIGN1cnJlbnQgdmF1bHQgYWdhaW5zdCBsYXN0IHNuYXBzaG90LlxuICAgKiBSZXR1cm5zIG9wcyB0aGF0IGhhcHBlbmVkIHdoaWxlIHBsdWdpbiB3YXMgb2ZmbGluZS5cbiAgICogTXVzdCBiZSBjYWxsZWQgYWZ0ZXIgb25MYXlvdXRSZWFkeSBzbyB2YXVsdC5nZXRGaWxlcygpIHJldHVybnMgYWNjdXJhdGUgc3RhdHMuXG4gICAqL1xuICBjb21wdXRlRGlmZihleGNsdWRlOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuKTogUGVuZGluZ09wcyB7XG4gICAgY29uc3Qgb3BzOiBQZW5kaW5nT3BzID0ge307XG4gICAgY29uc3QgY3VycmVudEZpbGVzID0gdGhpcy5hcHAudmF1bHQuZ2V0RmlsZXMoKTtcbiAgICBjb25zdCBjdXJyZW50UGF0aHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAgIGZvciAoY29uc3QgZiBvZiBjdXJyZW50RmlsZXMpIHtcbiAgICAgIGlmIChleGNsdWRlKGYucGF0aCkpIGNvbnRpbnVlO1xuICAgICAgY3VycmVudFBhdGhzLmFkZChmLnBhdGgpO1xuICAgICAgY29uc3Qgc25hcCA9IHRoaXMuc25hcHNob3RbZi5wYXRoXTtcbiAgICAgIGlmICghc25hcCkge1xuICAgICAgICBvcHNbZi5wYXRoXSA9ICdjcmVhdGUnO1xuICAgICAgfSBlbHNlIGlmICgoZi5zdGF0Lm10aW1lIC0gc25hcC5tdGltZSA+IDIwMDApIHx8IGYuc3RhdC5zaXplICE9PSBzbmFwLnNpemUpIHtcbiAgICAgICAgb3BzW2YucGF0aF0gPSAnbW9kaWZ5JztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHAgb2YgT2JqZWN0LmtleXModGhpcy5zbmFwc2hvdCkpIHtcbiAgICAgIGlmICghY3VycmVudFBhdGhzLmhhcyhwKSkge1xuICAgICAgICBvcHNbcF0gPSAnZGVsZXRlJztcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gb3BzO1xuICB9XG5cbiAgZ2V0KHBhdGg6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLnNuYXBzaG90W3BhdGhdO1xuICB9XG5cbiAgZ2V0QWxsKCk6IFNuYXBzaG90IHtcbiAgICByZXR1cm4gdGhpcy5zbmFwc2hvdDtcbiAgfVxufVxuIiwgIi8qKlxuICogU3luY2VyIFx1MjAxNCBjb3JlIHN5bmMgZW5naW5lLlxuICogSGFuZGxlcyBwdXNoLCBwdWxsLCBzbWFydCBzeW5jLCBjb25mbGljdCBkZXRlY3Rpb24uXG4gKi9cblxuaW1wb3J0IHsgQXBwLCBub3JtYWxpemVQYXRoLCBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IERyaXZlQXBpIH0gZnJvbSAnLi9kcml2ZUFwaSc7XG5pbXBvcnQgeyBQYXRoSW5kZXggfSBmcm9tICcuL3BhdGhJbmRleCc7XG5pbXBvcnQgeyBWYXVsdFNuYXBzaG90IH0gZnJvbSAnLi9zbmFwc2hvdCc7XG5pbXBvcnQgeyBOZW9TZXR0aW5ncywgUGVuZGluZ09wcywgQ29uZmxpY3RSZWNvcmQsIERyaXZlQ2hhbmdlIH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgKiBhcyBtaW1lIGZyb20gJy4vbWltZSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3luY1Jlc3VsdCB7XG4gIHB1c2hlZDogc3RyaW5nW107XG4gIHB1bGxlZDogc3RyaW5nW107XG4gIGRlbGV0ZWQ6IHN0cmluZ1tdO1xuICBjb25mbGljdHM6IENvbmZsaWN0UmVjb3JkW107XG4gIGVycm9yczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfT47XG59XG5cbmV4cG9ydCBjbGFzcyBTeW5jZXIge1xuICBjb25mbGljdHM6IENvbmZsaWN0UmVjb3JkW10gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIGFwcDogQXBwLFxuICAgIHByaXZhdGUgZHJpdmU6IERyaXZlQXBpLFxuICAgIHByaXZhdGUgaW5kZXg6IFBhdGhJbmRleCxcbiAgICBwcml2YXRlIHNuYXBzaG90OiBWYXVsdFNuYXBzaG90LFxuICAgIHByaXZhdGUgc2V0dGluZ3M6IE5lb1NldHRpbmdzLFxuICAgIHByaXZhdGUgcGVuZGluZ09wczogUGVuZGluZ09wcyxcbiAgICBwcml2YXRlIG9uUHJvZ3Jlc3M6IChtc2c6IHN0cmluZykgPT4gdm9pZCxcbiAgKSB7fVxuXG4gIHByaXZhdGUgZXhjbHVkZShwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAocGF0aC5zdGFydHNXaXRoKCcubmVvZ2RzeW5jLycpKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAocGF0aC5zdGFydHNXaXRoKCcuc21hcnQtZW52LycpKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAocGF0aC5zdGFydHNXaXRoKCcuc210Y21wJykpIHJldHVybiB0cnVlO1xuICAgIGlmIChwYXRoLmVuZHNXaXRoKCcuRFNfU3RvcmUnKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHBhdGguaW5jbHVkZXMoJ25vZGVfbW9kdWxlcy8nKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHBhdGguc3RhcnRzV2l0aCgnLmdpdC8nKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHBhdGggPT09ICcubmVvZ2RzeW5jJykgcmV0dXJuIHRydWU7XG4gICAgZm9yIChjb25zdCBwYXQgb2YgdGhpcy5zZXR0aW5ncy5leGNsdWRlUGF0aHMpIHtcbiAgICAgIGlmIChtYXRjaEdsb2IocGF0LCBwYXRoKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTbWFydCBTeW5jIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGFzeW5jIHNtYXJ0U3luYygpOiBQcm9taXNlPFN5bmNSZXN1bHQ+IHtcbiAgICBjb25zdCByZXN1bHQ6IFN5bmNSZXN1bHQgPSB7IHB1c2hlZDogW10sIHB1bGxlZDogW10sIGRlbGV0ZWQ6IFtdLCBjb25mbGljdHM6IFtdLCBlcnJvcnM6IFtdIH07XG5cbiAgICB0aGlzLm9uUHJvZ3Jlc3MoJ1NjYW5uaW5nIGxvY2FsIGNoYW5nZXNcdTIwMjYnKTtcbiAgICBjb25zdCBvZmZsaW5lRGlmZiA9IHRoaXMuc25hcHNob3QuY29tcHV0ZURpZmYocCA9PiB0aGlzLmV4Y2x1ZGUocCkpO1xuICAgIGZvciAoY29uc3QgW3BhdGgsIG9wXSBvZiBPYmplY3QuZW50cmllcyhvZmZsaW5lRGlmZikpIHtcbiAgICAgIGlmICghdGhpcy5wZW5kaW5nT3BzW3BhdGhdKSB0aGlzLnBlbmRpbmdPcHNbcGF0aF0gPSBvcDtcbiAgICB9XG5cbiAgICB0aGlzLm9uUHJvZ3Jlc3MoJ0ZldGNoaW5nIGRyaXZlIGNoYW5nZXNcdTIwMjYnKTtcbiAgICBsZXQgY2hhbmdlczogRHJpdmVDaGFuZ2VbXSA9IFtdO1xuICAgIGxldCBuZXdUb2tlbiA9IHRoaXMuc2V0dGluZ3MuY2hhbmdlc1Rva2VuO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIXRoaXMuc2V0dGluZ3MuY2hhbmdlc1Rva2VuKSB7XG4gICAgICAgIHRoaXMuc2V0dGluZ3MuY2hhbmdlc1Rva2VuID0gYXdhaXQgdGhpcy5kcml2ZS5nZXRTdGFydFBhZ2VUb2tlbigpO1xuICAgICAgfVxuICAgICAgY29uc3QgciA9IGF3YWl0IHRoaXMuZHJpdmUuZ2V0Q2hhbmdlcyh0aGlzLnNldHRpbmdzLmNoYW5nZXNUb2tlbik7XG4gICAgICBjaGFuZ2VzID0gci5jaGFuZ2VzO1xuICAgICAgbmV3VG9rZW4gPSByLm5ld1Rva2VuO1xuICAgIH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuICAgICAgY29uc29sZS53YXJuKCdbTmVvR0RTeW5jXSBDb3VsZCBub3QgZmV0Y2ggRHJpdmUgY2hhbmdlcywgcHVzaGluZyBsb2NhbCBjaGFuZ2VzIG9ubHk6JyxcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKTtcbiAgICB9XG5cbiAgICBjb25zdCBkcml2ZUNoYW5nZWQgPSBuZXcgTWFwPHN0cmluZywgeyByZW1vdmVkOiBib29sZWFuOyBtdGltZT86IHN0cmluZyB9PigpO1xuICAgIGNvbnN0IGRyaXZlSWRUb1BhdGggPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgcCBvZiB0aGlzLmluZGV4LmFsbFBhdGhzKCkpIHtcbiAgICAgIGNvbnN0IGUgPSB0aGlzLmluZGV4LmdldChwKTtcbiAgICAgIGlmIChlKSBkcml2ZUlkVG9QYXRoLnNldChlLmRyaXZlSWQsIHApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGMgb2YgY2hhbmdlcykge1xuICAgICAgY29uc3QgbG9jYWxQYXRoID0gZHJpdmVJZFRvUGF0aC5nZXQoYy5maWxlSWQpO1xuICAgICAgaWYgKGxvY2FsUGF0aCkge1xuICAgICAgICBkcml2ZUNoYW5nZWQuc2V0KGxvY2FsUGF0aCwgeyByZW1vdmVkOiBjLnJlbW92ZWQsIG10aW1lOiBjLmZpbGU/Lm1vZGlmaWVkVGltZSB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBCdWcgZml4OiByZXNvbHZlIERyaXZlIGNoYW5nZXMgd2hvc2UgZmlsZUlkIGlzIG5vdCB5ZXQgaW4gdGhlIGxvY2FsIGluZGV4LlxuICAgIC8vIFRoaXMgaGFwcGVucyB3aGVuIGEgZGV2aWNlJ3MgaW5kZXggaXMgc3RhbGUgKGUuZy4gYWZ0ZXIgcmVpbnN0YWxsIG9yIHJlYnVpbGQpLFxuICAgIC8vIGNhdXNpbmcgbmV3IGZpbGVzIGZyb20gb3RoZXIgZGV2aWNlcyB0byBiZSBzaWxlbnRseSBkcm9wcGVkIGV2ZXJ5IHN5bmMuXG4gICAgY29uc3QgRk9MREVSX01JTUUgPSAnYXBwbGljYXRpb24vdm5kLmdvb2dsZS1hcHBzLmZvbGRlcic7XG4gICAgY29uc3QgdW5rbm93bkNoYW5nZXMgPSBjaGFuZ2VzLmZpbHRlcihjID0+ICFkcml2ZUlkVG9QYXRoLmhhcyhjLmZpbGVJZCkgJiYgIWMucmVtb3ZlZCk7XG4gICAgaWYgKHVua25vd25DaGFuZ2VzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIEJ1aWxkIHJldmVyc2UgbWFwOiBkcml2ZUlkIFx1MjE5MiBsb2NhbFBhdGggZm9yIGFsbCBrbm93biBmb2xkZXJzICgrIHZhdWx0IHJvb3QpXG4gICAgICBjb25zdCBmb2xkZXJJZFRvUGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgICBmb2xkZXJJZFRvUGF0aC5zZXQodGhpcy5zZXR0aW5ncy52YXVsdFJvb3RJZCwgJycpO1xuICAgICAgZm9yIChjb25zdCBwIG9mIHRoaXMuaW5kZXguYWxsUGF0aHMoKSkge1xuICAgICAgICBjb25zdCBlID0gdGhpcy5pbmRleC5nZXQocCk7XG4gICAgICAgIGlmIChlPy5pc0ZvbGRlcikgZm9sZGVySWRUb1BhdGguc2V0KGUuZHJpdmVJZCwgcCk7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IGMgb2YgdW5rbm93bkNoYW5nZXMpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgdGhpcy5kcml2ZS5nZXRGaWxlTWV0YShjLmZpbGVJZCk7XG4gICAgICAgICAgaWYgKG1ldGEubWltZVR5cGUgPT09IEZPTERFUl9NSU1FKSBjb250aW51ZTtcbiAgICAgICAgICBjb25zdCBwYXJlbnRJZCA9IG1ldGEucGFyZW50cz8uWzBdO1xuICAgICAgICAgIGlmICghcGFyZW50SWQpIHtcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgW05lb0dEU3luY10gVW5rbm93biBmaWxlSWQgJHtjLmZpbGVJZH0gKCR7bWV0YS5uYW1lfSkgaGFzIG5vIHBhcmVudCwgc2tpcHBpbmdgKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBmb2xkZXJQYXRoID0gZm9sZGVySWRUb1BhdGguZ2V0KHBhcmVudElkKTtcbiAgICAgICAgICBpZiAoZm9sZGVyUGF0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtOZW9HRFN5bmNdIFVua25vd24gZmlsZUlkICR7Yy5maWxlSWR9ICgke21ldGEubmFtZX0pOiBwYXJlbnQgZm9sZGVyICR7cGFyZW50SWR9IG5vdCBpbiBpbmRleCBcdTIwMTQgcnVuIFJlYnVpbGQgSW5kZXggdG8gcmVwYWlyYCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgbG9jYWxQYXRoID0gZm9sZGVyUGF0aCA/IGAke2ZvbGRlclBhdGh9LyR7bWV0YS5uYW1lfWAgOiBtZXRhLm5hbWU7XG4gICAgICAgICAgaWYgKHRoaXMuZXhjbHVkZShsb2NhbFBhdGgpKSBjb250aW51ZTtcbiAgICAgICAgICAvLyBQcmUtcG9wdWxhdGUgaW5kZXggc28gcHVsbE5ld0Zyb21Ecml2ZSBjYW4gZG93bmxvYWQgdGhpcyBmaWxlXG4gICAgICAgICAgdGhpcy5pbmRleC5zZXQobG9jYWxQYXRoLCB7XG4gICAgICAgICAgICBkcml2ZUlkOiBjLmZpbGVJZCxcbiAgICAgICAgICAgIGRyaXZlTXRpbWU6IG1ldGEubW9kaWZpZWRUaW1lLFxuICAgICAgICAgICAgc3luY2VkQXQ6IDAsXG4gICAgICAgICAgICBpc0ZvbGRlcjogZmFsc2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgZHJpdmVJZFRvUGF0aC5zZXQoYy5maWxlSWQsIGxvY2FsUGF0aCk7XG4gICAgICAgICAgZHJpdmVDaGFuZ2VkLnNldChsb2NhbFBhdGgsIHsgcmVtb3ZlZDogZmFsc2UsIG10aW1lOiBtZXRhLm1vZGlmaWVkVGltZSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKGBbTmVvR0RTeW5jXSBDb3VsZCBub3QgcmVzb2x2ZSB1bmtub3duIGZpbGVJZCAke2MuZmlsZUlkfTpgLFxuICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGFsbE9wcyA9IE9iamVjdC5lbnRyaWVzKHRoaXMucGVuZGluZ09wcyk7XG4gICAgbGV0IGRvbmUgPSAwO1xuICAgIGZvciAoY29uc3QgW3BhdGgsIG9wXSBvZiBhbGxPcHMpIHtcbiAgICAgIHRoaXMub25Qcm9ncmVzcyhgWyR7Kytkb25lfS8ke2FsbE9wcy5sZW5ndGh9XSAke29wfTogJHtwYXRofWApO1xuICAgICAgaWYgKHRoaXMuZXhjbHVkZShwYXRoKSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAob3AgPT09ICdkZWxldGUnKSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5oYW5kbGVEZWxldGUocGF0aCwgcmVzdWx0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBkcml2ZUNoYW5nZSA9IGRyaXZlQ2hhbmdlZC5nZXQocGF0aCk7XG4gICAgICAgICAgY29uc3QgaW5kZXhFbnRyeSA9IHRoaXMuaW5kZXguZ2V0KHBhdGgpO1xuICAgICAgICAgIGNvbnN0IGlzRHJpdmVOZXdlciA9IGRyaXZlQ2hhbmdlXG4gICAgICAgICAgICAmJiAhZHJpdmVDaGFuZ2UucmVtb3ZlZFxuICAgICAgICAgICAgJiYgZHJpdmVDaGFuZ2UubXRpbWVcbiAgICAgICAgICAgICYmIGluZGV4RW50cnlcbiAgICAgICAgICAgICYmIGRyaXZlQ2hhbmdlLm10aW1lID4gaW5kZXhFbnRyeS5kcml2ZU10aW1lO1xuICAgICAgICAgIGlmIChpc0RyaXZlTmV3ZXIpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuaGFuZGxlQ29uZmxpY3QocGF0aCwgZHJpdmVDaGFuZ2UubXRpbWUgYXMgc3RyaW5nLCByZXN1bHQpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmhhbmRsZVB1c2gocGF0aCwgb3AsIHJlc3VsdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKHsgcGF0aCwgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGVkID0gbmV3IFNldChbLi4ucmVzdWx0LnB1c2hlZCwgLi4ucmVzdWx0LnB1bGxlZCwgLi4ucmVzdWx0LmRlbGV0ZWRdKTtcbiAgICBhd2FpdCB0aGlzLnB1bGxOZXdGcm9tRHJpdmUoZHJpdmVDaGFuZ2VkLCByZXN1bHQsIGhhbmRsZWQpO1xuXG4gICAgdGhpcy5zZXR0aW5ncy5jaGFuZ2VzVG9rZW4gPSBuZXdUb2tlbjtcbiAgICB0aGlzLnNldHRpbmdzLmxhc3RTeW5jZWRBdCA9IERhdGUubm93KCk7XG4gICAgdGhpcy5zbmFwc2hvdC5zYXZlKHAgPT4gdGhpcy5leGNsdWRlKHApKTtcbiAgICBhd2FpdCB0aGlzLmluZGV4LnNhdmUoKTtcblxuICAgIGZvciAoY29uc3QgcCBvZiBbLi4ucmVzdWx0LnB1c2hlZCwgLi4ucmVzdWx0LmRlbGV0ZWQsIC4uLnJlc3VsdC5wdWxsZWRdKSB7XG4gICAgICBkZWxldGUgdGhpcy5wZW5kaW5nT3BzW3BdO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEZvcmNlIFB1c2ggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgYXN5bmMgZm9yY2VQdXNoKCk6IFByb21pc2U8U3luY1Jlc3VsdD4ge1xuICAgIGNvbnN0IHJlc3VsdDogU3luY1Jlc3VsdCA9IHsgcHVzaGVkOiBbXSwgcHVsbGVkOiBbXSwgZGVsZXRlZDogW10sIGNvbmZsaWN0czogW10sIGVycm9yczogW10gfTtcbiAgICBjb25zdCBhbGxPcHMgPSBPYmplY3QuZW50cmllcyh0aGlzLnBlbmRpbmdPcHMpO1xuICAgIGxldCBkb25lID0gMDtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBvcF0gb2YgYWxsT3BzKSB7XG4gICAgICB0aGlzLm9uUHJvZ3Jlc3MoYFskeysrZG9uZX0vJHthbGxPcHMubGVuZ3RofV0gcHVzaDogJHtwYXRofWApO1xuICAgICAgaWYgKHRoaXMuZXhjbHVkZShwYXRoKSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAob3AgPT09ICdkZWxldGUnKSBhd2FpdCB0aGlzLmhhbmRsZURlbGV0ZShwYXRoLCByZXN1bHQpO1xuICAgICAgICBlbHNlIGF3YWl0IHRoaXMuaGFuZGxlUHVzaChwYXRoLCBvcCwgcmVzdWx0KTtcbiAgICAgIH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goeyBwYXRoLCBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnNldHRpbmdzLmxhc3RTeW5jZWRBdCA9IERhdGUubm93KCk7XG4gICAgaWYgKCF0aGlzLnNldHRpbmdzLmNoYW5nZXNUb2tlbikge1xuICAgICAgdGhpcy5zZXR0aW5ncy5jaGFuZ2VzVG9rZW4gPSBhd2FpdCB0aGlzLmRyaXZlLmdldFN0YXJ0UGFnZVRva2VuKCk7XG4gICAgfVxuICAgIHRoaXMuc25hcHNob3Quc2F2ZShwID0+IHRoaXMuZXhjbHVkZShwKSk7XG4gICAgYXdhaXQgdGhpcy5pbmRleC5zYXZlKCk7XG4gICAgZm9yIChjb25zdCBwIG9mIFsuLi5yZXN1bHQucHVzaGVkLCAuLi5yZXN1bHQuZGVsZXRlZCwgLi4ucmVzdWx0LnB1bGxlZF0pIHtcbiAgICAgIGRlbGV0ZSB0aGlzLnBlbmRpbmdPcHNbcF07XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgRm9yY2UgUHVsbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBhc3luYyBmb3JjZVB1bGwoKTogUHJvbWlzZTxTeW5jUmVzdWx0PiB7XG4gICAgY29uc3QgcmVzdWx0OiBTeW5jUmVzdWx0ID0geyBwdXNoZWQ6IFtdLCBwdWxsZWQ6IFtdLCBkZWxldGVkOiBbXSwgY29uZmxpY3RzOiBbXSwgZXJyb3JzOiBbXSB9O1xuICAgIHRoaXMub25Qcm9ncmVzcygnUmVidWlsZGluZyBkcml2ZSBpbmRleFx1MjAyNicpO1xuICAgIGF3YWl0IHRoaXMuaW5kZXgucmVidWlsZChtc2cgPT4gdGhpcy5vblByb2dyZXNzKGBDcmF3bGluZzogJHttc2d9YCkpO1xuICAgIGNvbnN0IHBhdGhzID0gdGhpcy5pbmRleC5hbGxQYXRocygpO1xuICAgIGxldCBkb25lID0gMDtcbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5pbmRleC5nZXQocGF0aCk7XG4gICAgICBpZiAoIWVudHJ5IHx8IGVudHJ5LmlzRm9sZGVyKSBjb250aW51ZTtcbiAgICAgIHRoaXMub25Qcm9ncmVzcyhgWyR7Kytkb25lfV0gcHVsbDogJHtwYXRofWApO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYnl0ZXMgPSBhd2FpdCB0aGlzLmRyaXZlLmRvd25sb2FkRmlsZShlbnRyeS5kcml2ZUlkKTtcbiAgICAgICAgYXdhaXQgd3JpdGVMb2NhbCh0aGlzLmFwcCwgcGF0aCwgYnl0ZXMpO1xuICAgICAgICByZXN1bHQucHVsbGVkLnB1c2gocGF0aCk7XG4gICAgICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKHsgcGF0aCwgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5zZXR0aW5ncy5sYXN0U3luY2VkQXQgPSBEYXRlLm5vdygpO1xuICAgIHRoaXMuc25hcHNob3Quc2F2ZShwID0+IHRoaXMuZXhjbHVkZShwKSk7XG4gICAgYXdhaXQgdGhpcy5pbmRleC5zYXZlKCk7XG4gICAgZm9yIChjb25zdCBwIG9mIFsuLi5yZXN1bHQucHVsbGVkLCAuLi5yZXN1bHQuZGVsZXRlZF0pIHtcbiAgICAgIGRlbGV0ZSB0aGlzLnBlbmRpbmdPcHNbcF07XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgSW50ZXJuYWwgaGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBwcml2YXRlIGFzeW5jIGhhbmRsZVB1c2gocGF0aDogc3RyaW5nLCBvcDogJ2NyZWF0ZScgfCAnbW9kaWZ5JywgcmVzdWx0OiBTeW5jUmVzdWx0KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChub3JtYWxpemVQYXRoKHBhdGgpKTtcbiAgICBpZiAoIWZpbGUgfHwgIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSByZXR1cm47XG4gICAgY29uc3QgYnl0ZXMgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkQmluYXJ5KGZpbGUpO1xuICAgIGNvbnN0IG10aW1lID0gbmV3IERhdGUoZmlsZS5zdGF0Lm10aW1lKS50b0lTT1N0cmluZygpO1xuICAgIGNvbnN0IG1pbWVUeXBlID0gbWltZS5mcm9tUGF0aChwYXRoKTtcbiAgICBjb25zdCBjYWNoZWQgPSB0aGlzLmluZGV4LmdldChwYXRoKTtcbiAgICBpZiAoY2FjaGVkICYmICFjYWNoZWQuaXNGb2xkZXIpIHtcbiAgICAgIGF3YWl0IHRoaXMuZHJpdmUudXBkYXRlRmlsZShjYWNoZWQuZHJpdmVJZCwgYnl0ZXMsIG1pbWVUeXBlLCBtdGltZSwgdGhpcy5zZXR0aW5ncy5rZWVwUmV2aXNpb25zKTtcbiAgICAgIHRoaXMuaW5kZXguc2V0KHBhdGgsIHsgLi4uY2FjaGVkLCBkcml2ZU10aW1lOiBtdGltZSwgc3luY2VkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHBhcmVudElkID0gYXdhaXQgdGhpcy5pbmRleC5yZXNvbHZlUGFyZW50Rm9sZGVyKHBhdGgpO1xuICAgICAgY29uc3QgZHJpdmVJZCA9IGF3YWl0IHRoaXMuZHJpdmUudXBsb2FkRmlsZShcbiAgICAgICAgZmlsZS5uYW1lLCBwYXJlbnRJZCwgYnl0ZXMsIG1pbWVUeXBlLCBtdGltZSwgdGhpcy5zZXR0aW5ncy5rZWVwUmV2aXNpb25zLFxuICAgICAgKTtcbiAgICAgIHRoaXMuaW5kZXguc2V0KHBhdGgsIHsgZHJpdmVJZCwgZHJpdmVNdGltZTogbXRpbWUsIHN5bmNlZEF0OiBEYXRlLm5vdygpLCBpc0ZvbGRlcjogZmFsc2UgfSk7XG4gICAgfVxuICAgIHJlc3VsdC5wdXNoZWQucHVzaChwYXRoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlRGVsZXRlKHBhdGg6IHN0cmluZywgcmVzdWx0OiBTeW5jUmVzdWx0KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY2FjaGVkID0gdGhpcy5pbmRleC5nZXQocGF0aCk7XG4gICAgaWYgKGNhY2hlZCkge1xuICAgICAgdHJ5IHsgYXdhaXQgdGhpcy5kcml2ZS5kZWxldGVGaWxlKGNhY2hlZC5kcml2ZUlkKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICB0aGlzLmluZGV4LmRlbGV0ZShwYXRoKTtcbiAgICB9XG4gICAgcmVzdWx0LmRlbGV0ZWQucHVzaChwYXRoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlQ29uZmxpY3QocGF0aDogc3RyaW5nLCBkcml2ZU10aW1lOiBzdHJpbmcsIHJlc3VsdDogU3luY1Jlc3VsdCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5pbmRleC5nZXQocGF0aCk7XG4gICAgaWYgKCFlbnRyeSkgcmV0dXJuO1xuXG4gICAgLy8gQnVnIGZpeDogY29uZmxpY3QgZGlyZWN0aW9uIHdhcyByZXZlcnNlZCBcdTIwMTQgbG9jYWwgd2FzIHB1c2hlZCB0byBEcml2ZSwgb3ZlcndyaXRpbmdcbiAgICAvLyB0aGUgcmVtb3RlIChuZXdlcikgdmVyc2lvbi4gQ29ycmVjdCBiZWhhdmlvdXI6IGtlZXAgRHJpdmUgdmVyc2lvbiBhcyBhdXRob3JpdGF0aXZlLFxuICAgIC8vIHNhdmUgbG9jYWwgb2ZmbGluZSBlZGl0cyBhcyBhIC5jb25mbGljdCBjb3B5IGZvciB0aGUgdXNlciB0byByZXZpZXcgYW5kIG1lcmdlLlxuICAgIGNvbnN0IGV4dCA9IHBhdGguaW5jbHVkZXMoJy4nKSA/IHBhdGguc2xpY2UocGF0aC5sYXN0SW5kZXhPZignLicpKSA6ICcnO1xuICAgIGNvbnN0IGJhc2UgPSBleHQgPyBwYXRoLnNsaWNlKDAsIC1leHQubGVuZ3RoKSA6IHBhdGg7XG4gICAgY29uc3QgY29uZmxpY3RQYXRoID0gYCR7YmFzZX0uY29uZmxpY3Qke2V4dH1gO1xuXG4gICAgLy8gMS4gU2F2ZSBsb2NhbCBvZmZsaW5lIGVkaXRzIGFzIHRoZSBjb25mbGljdCBjb3B5XG4gICAgY29uc3QgbG9jYWxGaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5vcm1hbGl6ZVBhdGgocGF0aCkpO1xuICAgIGNvbnN0IGxvY2FsTXRpbWUgPSBsb2NhbEZpbGUgaW5zdGFuY2VvZiBURmlsZSA/IGxvY2FsRmlsZS5zdGF0Lm10aW1lIDogMDtcbiAgICBpZiAobG9jYWxGaWxlIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICAgIGNvbnN0IGxvY2FsQnl0ZXMgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkQmluYXJ5KGxvY2FsRmlsZSk7XG4gICAgICBhd2FpdCB3cml0ZUxvY2FsKHRoaXMuYXBwLCBjb25mbGljdFBhdGgsIGxvY2FsQnl0ZXMpO1xuICAgIH1cblxuICAgIC8vIDIuIFB1bGwgdGhlIERyaXZlIHZlcnNpb24gYXMgdGhlIGNhbm9uaWNhbCBsb2NhbCBmaWxlIChubyBwdXNoIHRvIERyaXZlKVxuICAgIGNvbnN0IGRyaXZlQnl0ZXMgPSBhd2FpdCB0aGlzLmRyaXZlLmRvd25sb2FkRmlsZShlbnRyeS5kcml2ZUlkKTtcbiAgICBhd2FpdCB3cml0ZUxvY2FsKHRoaXMuYXBwLCBwYXRoLCBkcml2ZUJ5dGVzKTtcbiAgICB0aGlzLmluZGV4LnNldChwYXRoLCB7IC4uLmVudHJ5LCBkcml2ZU10aW1lLCBzeW5jZWRBdDogRGF0ZS5ub3coKSB9KTtcblxuICAgIHJlc3VsdC5jb25mbGljdHMucHVzaCh7IGxvY2FsUGF0aDogcGF0aCwgbG9jYWxNdGltZSwgZHJpdmVNdGltZSwgY29uZmxpY3RDb3B5UGF0aDogY29uZmxpY3RQYXRoLCBkZXRlY3RlZEF0OiBEYXRlLm5vdygpIH0pO1xuICAgIHJlc3VsdC5wdWxsZWQucHVzaChwYXRoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcHVsbE5ld0Zyb21Ecml2ZShcbiAgICBkcml2ZUNoYW5nZWQ6IE1hcDxzdHJpbmcsIHsgcmVtb3ZlZDogYm9vbGVhbjsgbXRpbWU/OiBzdHJpbmcgfT4sXG4gICAgcmVzdWx0OiBTeW5jUmVzdWx0LFxuICAgIGhhbmRsZWQ6IFNldDxzdHJpbmc+LFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCBjaGFuZ2VdIG9mIGRyaXZlQ2hhbmdlZC5lbnRyaWVzKCkpIHtcbiAgICAgIGlmICh0aGlzLmV4Y2x1ZGUocGF0aCkpIGNvbnRpbnVlO1xuICAgICAgLy8gT25seSBza2lwIHBhdGhzIHN1Y2Nlc3NmdWxseSBoYW5kbGVkIGluIHRoZSBtYWluIGxvb3A7IHN0YWxlIHBlbmRpbmdPcHMgdGhhdFxuICAgICAgLy8gcmV0dXJuZWQgZWFybHkgKG1pc3NpbmcgbG9jYWwgZmlsZSwgbWlzc2luZyBpbmRleCBlbnRyeSkgbXVzdCBub3QgYmxvY2sgcHVsbHMuXG4gICAgICBpZiAoaGFuZGxlZC5oYXMocGF0aCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNoYW5nZS5yZW1vdmVkKSB7XG4gICAgICAgIGNvbnN0IGxvY2FsRmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChub3JtYWxpemVQYXRoKHBhdGgpKTtcbiAgICAgICAgaWYgKGxvY2FsRmlsZSkge1xuICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LnRyYXNoKGxvY2FsRmlsZSwgdHJ1ZSk7XG4gICAgICAgICAgdGhpcy5pbmRleC5kZWxldGUocGF0aCk7XG4gICAgICAgICAgcmVzdWx0LmRlbGV0ZWQucHVzaChwYXRoKTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5pbmRleC5nZXQocGF0aCk7XG4gICAgICBpZiAoIWVudHJ5IHx8IGVudHJ5LmlzRm9sZGVyKSBjb250aW51ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGJ5dGVzID0gYXdhaXQgdGhpcy5kcml2ZS5kb3dubG9hZEZpbGUoZW50cnkuZHJpdmVJZCk7XG4gICAgICAgIGF3YWl0IHdyaXRlTG9jYWwodGhpcy5hcHAsIHBhdGgsIGJ5dGVzKTtcbiAgICAgICAgaWYgKGNoYW5nZS5tdGltZSkge1xuICAgICAgICAgIHRoaXMuaW5kZXguc2V0KHBhdGgsIHsgLi4uZW50cnksIGRyaXZlTXRpbWU6IGNoYW5nZS5tdGltZSwgc3luY2VkQXQ6IERhdGUubm93KCkgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzdWx0LnB1bGxlZC5wdXNoKHBhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCh7IHBhdGgsIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBMb2NhbCBmaWxlIHdyaXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZUxvY2FsKGFwcDogQXBwLCBwYXRoOiBzdHJpbmcsIGJ5dGVzOiBBcnJheUJ1ZmZlcik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3JtID0gbm9ybWFsaXplUGF0aChwYXRoKTtcbiAgY29uc3QgcGFydHMgPSBwYXRoLnNwbGl0KCcvJyk7XG4gIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgY29uc3QgZGlyID0gbm9ybWFsaXplUGF0aChwYXJ0cy5zbGljZSgwLCAtMSkuam9pbignLycpKTtcbiAgICBpZiAoIShhd2FpdCBhcHAudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcbiAgICAgIGF3YWl0IGFwcC52YXVsdC5hZGFwdGVyLm1rZGlyKGRpcik7XG4gICAgfVxuICB9XG4gIGNvbnN0IGV4aXN0aW5nID0gYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChub3JtKTtcbiAgaWYgKGV4aXN0aW5nIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICBhd2FpdCBhcHAudmF1bHQubW9kaWZ5QmluYXJ5KGV4aXN0aW5nLCBieXRlcyk7XG4gIH0gZWxzZSB7XG4gICAgYXdhaXQgYXBwLnZhdWx0LmNyZWF0ZUJpbmFyeShub3JtLCBieXRlcyk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIEdsb2IgbWF0Y2hpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1hdGNoR2xvYihwYXR0ZXJuOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBsZXQgciA9ICcnO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHBhdHRlcm4ubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBjID0gcGF0dGVybltpXTtcbiAgICBpZiAoYyA9PT0gJyonICYmIHBhdHRlcm5baSArIDFdID09PSAnKicpIHtcbiAgICAgIHIgKz0gJy4qJztcbiAgICAgIGkrKztcbiAgICB9IGVsc2UgaWYgKGMgPT09ICcqJykge1xuICAgICAgciArPSAnW14vXSonO1xuICAgIH0gZWxzZSBpZiAoYyA9PT0gJz8nKSB7XG4gICAgICByICs9ICdbXi9dJztcbiAgICB9IGVsc2UgaWYgKCcuK14ke30oKXxbXVxcXFwnLmluY2x1ZGVzKGMpKSB7XG4gICAgICByICs9ICdcXFxcJyArIGM7XG4gICAgfSBlbHNlIHtcbiAgICAgIHIgKz0gYztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG5ldyBSZWdFeHAoJ14nICsgciArICckJykudGVzdChwYXRoKTtcbn1cbiIsICIvKiogTWluaW1hbCBNSU1FIHR5cGUgbG9va3VwIGJ5IGZpbGUgZXh0ZW5zaW9uICovXG5cbmNvbnN0IE1BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgbWQ6ICd0ZXh0L21hcmtkb3duJyxcbiAgdHh0OiAndGV4dC9wbGFpbicsXG4gIGh0bWw6ICd0ZXh0L2h0bWwnLFxuICBjc3M6ICd0ZXh0L2NzcycsXG4gIGpzOiAnYXBwbGljYXRpb24vamF2YXNjcmlwdCcsXG4gIHRzOiAnYXBwbGljYXRpb24vdHlwZXNjcmlwdCcsXG4gIGpzb246ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgcGRmOiAnYXBwbGljYXRpb24vcGRmJyxcbiAgcG5nOiAnaW1hZ2UvcG5nJyxcbiAganBnOiAnaW1hZ2UvanBlZycsXG4gIGpwZWc6ICdpbWFnZS9qcGVnJyxcbiAgZ2lmOiAnaW1hZ2UvZ2lmJyxcbiAgd2VicDogJ2ltYWdlL3dlYnAnLFxuICBzdmc6ICdpbWFnZS9zdmcreG1sJyxcbiAgbXA0OiAndmlkZW8vbXA0JyxcbiAgbXAzOiAnYXVkaW8vbXBlZycsXG4gIHppcDogJ2FwcGxpY2F0aW9uL3ppcCcsXG4gIHhsc3g6ICdhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldCcsXG4gIGRvY3g6ICdhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQud29yZHByb2Nlc3NpbmdtbC5kb2N1bWVudCcsXG4gIHBwdHg6ICdhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQucHJlc2VudGF0aW9ubWwucHJlc2VudGF0aW9uJyxcbiAgY3N2OiAndGV4dC9jc3YnLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGZyb21QYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGV4dCA9IHBhdGguc3BsaXQoJy4nKS5wb3AoKT8udG9Mb3dlckNhc2UoKSA/PyAnJztcbiAgcmV0dXJuIE1BUFtleHRdID8/ICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFBQUEsbUJBR087OztBQ1NBLElBQU0sbUJBQWdDO0FBQUEsRUFDM0MsY0FBYztBQUFBLEVBQ2QsYUFBYTtBQUFBLEVBQ2IsY0FBYztBQUFBLEVBQ2QsY0FBYztBQUFBLEVBQ2QsY0FBYztBQUFBLEVBQ2QsVUFBVTtBQUFBLEVBQ1YsZUFBZTtBQUFBLEVBQ2YsY0FBYztBQUFBLElBQ1o7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFBQSxFQUNBLGFBQWE7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RUFBRSxLQUFLLENBQUM7QUFDOUUsY0FBTSxLQUFLLE9BQU8sTUFBTSxLQUFLO0FBQzdCLGNBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxNQUNqQyxDQUFDO0FBQUEsSUFDTCxDQUFDO0FBRUgsUUFBSSx5QkFBUSxXQUFXLEVBQ3BCLFFBQVEsV0FBVyxFQUFFLFFBQVEsMENBQTBDLEVBQ3ZFLFlBQVksT0FBSyxFQUNmLFVBQVUsU0FBUyx5QkFBeUIsRUFDNUMsVUFBVSxRQUFRLFlBQVksRUFDOUIsVUFBVSxRQUFRLFlBQVksRUFDOUIsU0FBUyxLQUFLLE9BQU8sU0FBUyxRQUFRLEVBQ3RDLFNBQVMsT0FBTSxNQUFLO0FBQ25CLFdBQUssT0FBTyxTQUFTLFdBQVc7QUFDaEMsWUFBTSxLQUFLLE9BQU8sYUFBYTtBQUFBLElBQ2pDLENBQUMsQ0FBQztBQUVOLFFBQUkseUJBQVEsV0FBVyxFQUNwQixRQUFRLGdCQUFnQixFQUFFLFFBQVEsZ0RBQWdELEVBQ2xGLFVBQVUsT0FBSyxFQUFFLFNBQVMsS0FBSyxPQUFPLFNBQVMsYUFBYSxFQUMxRCxTQUFTLE9BQU0sTUFBSztBQUFFLFdBQUssT0FBTyxTQUFTLGdCQUFnQjtBQUFHLFlBQU0sS0FBSyxPQUFPLGFBQWE7QUFBQSxJQUFHLENBQUMsQ0FBQztBQUV2RyxRQUFJLHlCQUFRLFdBQVcsRUFDcEIsUUFBUSxhQUFhLEVBQUUsUUFBUSxHQUFHLE9BQU8sS0FBSyxLQUFLLE9BQU8sVUFBVSxFQUFFLE1BQU0sZUFBZSxFQUMzRixVQUFVLE9BQUssRUFBRSxjQUFjLFdBQVcsRUFBRSxRQUFRLFlBQVk7QUFDL0QsV0FBSyxPQUFPLGFBQWEsQ0FBQztBQUMxQixZQUFNLEtBQUssT0FBTyxhQUFhO0FBQy9CLFdBQUssT0FBTyxhQUFhO0FBQ3pCLFdBQUssUUFBUTtBQUFBLElBQ2YsQ0FBQyxDQUFDO0FBRUosUUFBSSx5QkFBUSxXQUFXLEVBQ3BCLFFBQVEscUJBQXFCLEVBQUUsUUFBUSxxREFBcUQsRUFDNUYsVUFBVSxPQUFLLEVBQUUsY0FBYyxTQUFTLEVBQUUsUUFBUSxNQUFNO0FBQUUsV0FBSyxLQUFLLE9BQU8sYUFBYTtBQUFBLElBQUcsQ0FBQyxDQUFDO0FBRWhHLFFBQUkseUJBQVEsV0FBVyxFQUFFLFFBQVEsUUFBUSxFQUFFLFdBQVc7QUFDdEQsUUFBSSx5QkFBUSxXQUFXLEVBQ3BCLFFBQVEsY0FBYyxLQUFLLE9BQU8sU0FBUyxlQUFlLElBQUksS0FBSyxLQUFLLE9BQU8sU0FBUyxZQUFZLEVBQUUsZUFBZSxJQUFJLE9BQU8sRUFBRSxFQUNsSSxRQUFRLGNBQWMsS0FBSyxPQUFPLFVBQVUsTUFBTSxFQUFFO0FBQUEsRUFDekQ7QUFDRjsiLAogICJuYW1lcyI6IFsiaW1wb3J0X29ic2lkaWFuIiwgImltcG9ydF9vYnNpZGlhbiIsICJpbXBvcnRfb2JzaWRpYW4iLCAiRk9MREVSX01JTUUiLCAiY2FjaGVkIiwgImltcG9ydF9vYnNpZGlhbiIsICJGT0xERVJfTUlNRSIsICJjYWNoZWQiXQp9Cg==
