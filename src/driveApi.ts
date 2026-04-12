/** Google Drive API v3 wrapper */

import { getAccessToken } from './auth';
import { DriveFileInfo } from './types';

const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function req(
  method: string,
  url: string,
  body?: BodyInit,
  headers?: Record<string, string>,
  refreshToken?: string,
): Promise<Response> {
  const token = refreshToken ? await getAccessToken(refreshToken) : '';
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Drive ${method} ${url} → ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp;
}

export class DriveApi {
  constructor(private refreshToken: string) {}

  private async fetch(method: string, url: string, body?: BodyInit, headers?: Record<string, string>) {
    return req(method, url, body, headers, this.refreshToken);
  }

  // ── Folder operations ──────────────────────────────────────────

  /** List direct children of a folder */
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
      const resp = await this.fetch('GET', `${BASE}/files?${params}`);
      const data = await resp.json();
      results.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return results;
  }

  /** Create a folder, return its Drive ID */
  async createFolder(name: string, parentId: string): Promise<string> {
    const resp = await this.fetch(
      'POST',
      `${BASE}/files?fields=id`,
      JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      { 'Content-Type': 'application/json' },
    );
    const { id } = await resp.json();
    return id;
  }

  // ── File operations ────────────────────────────────────────────

  /** Upload a new file (multipart). Returns Drive ID. */
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
    const resp = await this.fetch(
      'POST',
      `${UPLOAD}/files?${params}`,
      body,
      { 'Content-Type': `multipart/related; boundary=${boundary}` },
    );
    const { id } = await resp.json();
    return id;
  }

  /** Update existing file content. Returns Drive ID (unchanged). */
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
    const resp = await this.fetch(
      'PATCH',
      `${UPLOAD}/files/${driveId}?${params}`,
      body,
      { 'Content-Type': `multipart/related; boundary=${boundary}` },
    );
    const { id } = await resp.json();
    return id;
  }

  /** Rename a file on Drive */
  async renameFile(driveId: string, newName: string): Promise<void> {
    await this.fetch(
      'PATCH',
      `${BASE}/files/${driveId}?fields=id`,
      JSON.stringify({ name: newName }),
      { 'Content-Type': 'application/json' },
    );
  }

  /** Delete a file (move to trash) */
  async deleteFile(driveId: string): Promise<void> {
    await this.fetch('DELETE', `${BASE}/files/${driveId}`);
  }

  /** Download file content */
  async downloadFile(driveId: string): Promise<ArrayBuffer> {
    const resp = await this.fetch('GET', `${BASE}/files/${driveId}?alt=media`);
    return resp.arrayBuffer();
  }

  /** Get file metadata */
  async getFileMeta(driveId: string): Promise<DriveFileInfo> {
    const resp = await this.fetch('GET', `${BASE}/files/${driveId}?fields=id,name,mimeType,modifiedTime,parents,size`);
    return resp.json();
  }

  /** Get Drive changes since a token */
  async getChanges(pageToken: string): Promise<{ changes: any[]; newToken: string }> {
    const changes: any[] = [];
    let token = pageToken;
    while (token) {
      const params = new URLSearchParams({
        pageToken: token,
        pageSize: '1000',
        includeRemoved: 'true',
        fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime))',
      });
      const resp = await this.fetch('GET', `${BASE}/changes?${params}`);
      const data = await resp.json();
      changes.push(...(data.changes ?? []));
      token = data.nextPageToken ?? '';
      if (data.newStartPageToken) {
        return { changes, newToken: data.newStartPageToken };
      }
    }
    return { changes, newToken: pageToken };
  }

  /** Get a fresh start page token */
  async getStartPageToken(): Promise<string> {
    const resp = await this.fetch('GET', `${BASE}/changes/startPageToken`);
    const { startPageToken } = await resp.json();
    return startPageToken;
  }

  /** List revisions of a file */
  async listRevisions(driveId: string): Promise<any[]> {
    const resp = await this.fetch('GET', `${BASE}/files/${driveId}/revisions?fields=revisions(id,modifiedTime,size)`);
    const data = await resp.json();
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
