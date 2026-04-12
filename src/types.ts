export interface NeoSettings {
  refreshToken: string;
  vaultRootId: string;
  authProxyUrl: string;          // OAuth2 proxy endpoint
  lastSyncedAt: number;
  changesToken: string;
  syncMode: 'smart' | 'push' | 'pull';
  keepRevisions: boolean;
  excludePaths: string[];        // glob patterns to exclude
  concurrency: number;           // parallel upload limit
}

export const DEFAULT_SETTINGS: NeoSettings = {
  refreshToken: '',
  vaultRootId: '',
  authProxyUrl: 'https://ogd.richardxiong.com/api/access',
  lastSyncedAt: 0,
  changesToken: '',
  syncMode: 'smart',
  keepRevisions: true,
  excludePaths: [
    '.smart-env/**',
    '.smtcmp*',
    '.git/**',
    '**/.DS_Store',
    '**/node_modules/**',
    '.neogdsync/**',
  ],
  concurrency: 6,
};

// Stored in .neogdsync/index.db — NOT in data.json
export interface IndexEntry {
  driveId: string;
  driveMtime: string;   // ISO string from Drive
  syncedAt: number;     // local Date.now() when synced
  isFolder: boolean;
}
export interface FileIndex {
  [localPath: string]: IndexEntry;
}

// Stored in .neogdsync/snapshot.json — NOT in data.json
export interface SnapshotEntry {
  mtime: number;    // ms
  size: number;     // bytes
}
export interface Snapshot {
  [localPath: string]: SnapshotEntry;
}

// In-memory only, cleared after each sync
export type OpType = 'create' | 'modify' | 'delete';
export interface PendingOps {
  [localPath: string]: OpType;
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents?: string[];
  size?: string;
}

export interface ConflictRecord {
  localPath: string;
  localMtime: number;
  driveMtime: string;
  conflictCopyPath: string;
  detectedAt: number;
}
