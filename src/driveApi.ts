/** Google Drive API v3 wrapper */

import { requestUrl } from 'obsidian';
import { getAccessToken } from './auth';
import { DriveFileInfo, DriveChange, DriveRevision } from './types';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function driveRequest(
  method: string,
  url: string,
  body?: string | ArrayBuffer,
  headers?: Record<string, string>,
  refreshToken?: string,
): Promise<{ status: number; json: unknown; text: string; arrayBuffer: ArrayBuffer }> {
  const token = refreshToken ? await getAccessToken(refreshToken) : '';
  const resp = await requestUrl({
    url,
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    throw: false,
  });
  if (resp.status >= 400) {
    const txt = resp.text.slice(0, 200);
    throw new Error(`Drive ${method} ${url} → ${resp.status}: ${txt}`);
  }
  return resp;
}

export class DriveApi {
  constructor(private refreshToken: string) {}

  private request(method: string, url: string, body?: string | ArrayBuffer, headers?: Record<string, string>) {
    return driveRequest(method, url, body, headers, this.refreshToken);
  }

  // ── Folder operations ──────────────────────────────────────────

  async listChildren(folderId: string): Promise<DriveFileInfo[]> {
    const results: DriveFileInfo[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const resp = await this.request('GET', `${BASE}/files?${params}`);
      const data = resp.json as { files?: DriveFileInfo[]; nextPageToken?: string };
      results.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return results;
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const resp = await this.request(
      'POST',
      `${BASE}/files?fields=id`,
      JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      { 'Content-Type': 'application/json' },
    );
    const { id } = resp.json as { id: string };
    return id;
  }

  // ── File operations ────────────────────────────────────────────

  async uploadFile(
    name: string,
    parentId: string,
    content: ArrayBuffer,
    mimeType: string,
    modifiedTime: string,
    keepRevision = false,
  ): Promise<string> {
    const boundary = 'neogdsync_boundary';
    const meta = JSON.stringify({ name, parents: [parentId], modifiedTime });
    const body = buildMultipart(boundary, meta, content, mimeType);
    const params = new URLSearchParams({ uploadType: 'multipart', fields: 'id' });
    if (keepRevision) params.set('keepRevisionForever', 'true');
    const resp = await this.request(
      'POST',
      `${UPLOAD}/files?${params}`,
      body.buffer as ArrayBuffer,
      { 'Content-Type': `multipart/related; boundary=${boundary}` },
    );
    const { id } = resp.json as { id: string };
    return id;
  }

  async updateFile(
    driveId: string,
    content: ArrayBuffer,
    mimeType: string,
    modifiedTime: string,
    keepRevision = false,
  ): Promise<string> {
    const boundary = 'neogdsync_boundary';
    const meta = JSON.stringify({ modifiedTime });
    const body = buildMultipart(boundary, meta, content, mimeType);
    const params = new URLSearchParams({ uploadType: 'multipart', fields: 'id' });
    if (keepRevision) params.set('keepRevisionForever', 'true');
    const resp = await this.request(
      'PATCH',
      `${UPLOAD}/files/${driveId}?${params}`,
      body.buffer as ArrayBuffer,
      { 'Content-Type': `multipart/related; boundary=${boundary}` },
    );
    const { id } = resp.json as { id: string };
    return id;
  }

  async moveFile(driveId: string, oldParentId: string, newParentId: string): Promise<void> {
    const params = new URLSearchParams({ addParents: newParentId, removeParents: oldParentId, fields: 'id' });
    await this.request('PATCH', `${BASE}/files/${driveId}?${params}`);
  }

  async renameFile(driveId: string, newName: string): Promise<void> {
    await this.request(
      'PATCH',
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ name: newName }),
      { 'Content-Type': 'application/json' },
    );
  }

  async deleteFile(driveId: string): Promise<void> {
    // Bug fix: previously used HTTP DELETE which is permanent and bypasses Drive trash,
    // making accidental local deletions unrecoverable. PATCH trashed=true instead so the
    // user has ~30 days to restore from Drive trash.
    await this.request(
      'PATCH',
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ trashed: true }),
      { 'Content-Type': 'application/json' },
    );
  }

  async downloadFile(driveId: string): Promise<ArrayBuffer> {
    const resp = await this.request('GET', `${BASE}/files/${driveId}?alt=media`);
    return resp.arrayBuffer;
  }

  async getFileMeta(driveId: string): Promise<DriveFileInfo> {
    // `trashed` field added so callers can detect files that have been moved to Drive trash
    // (see syncer.ts unknownChanges: a stale "modified" event must not resurrect a trashed file).
    const resp = await this.request('GET', `${BASE}/files/${driveId}?fields=id,name,mimeType,modifiedTime,parents,size,trashed`);
    return resp.json as DriveFileInfo;
  }

  async getChanges(pageToken: string): Promise<{ changes: DriveChange[]; newToken: string }> {
    const changes: DriveChange[] = [];
    let token = pageToken;
    while (token) {
      const params = new URLSearchParams({
        pageToken: token,
        pageSize: '1000',
        includeRemoved: 'true',
        fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,trashed))',
      });
      const resp = await this.request('GET', `${BASE}/changes?${params}`);
      const data = resp.json as {
        changes?: DriveChange[];
        nextPageToken?: string;
        newStartPageToken?: string;
      };
      changes.push(...(data.changes ?? []));
      token = data.nextPageToken ?? '';
      if (data.newStartPageToken) {
        return { changes, newToken: data.newStartPageToken };
      }
    }
    return { changes, newToken: pageToken };
  }

  async getStartPageToken(): Promise<string> {
    const resp = await this.request('GET', `${BASE}/changes/startPageToken`);
    const { startPageToken } = resp.json as { startPageToken: string };
    return startPageToken;
  }

  async listRevisions(driveId: string): Promise<DriveRevision[]> {
    const resp = await this.request('GET', `${BASE}/files/${driveId}/revisions?fields=revisions(id,modifiedTime,size)`);
    const data = resp.json as { revisions?: DriveRevision[] };
    return data.revisions ?? [];
  }
}

// ── helpers ────────────────────────────────────────────────────

function buildMultipart(boundary: string, meta: string, content: ArrayBuffer, mime: string): Uint8Array {
  const enc = new TextEncoder();
  const header = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const footer = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(header.byteLength + content.byteLength + footer.byteLength);
  body.set(header, 0);
  body.set(new Uint8Array(content), header.byteLength);
  body.set(footer, header.byteLength + content.byteLength);
  return body;
}
