export interface NeoSettings {
  refreshToken: string;
  vaultRootId: string;
  authProxyUrl: string;
  lastSyncedAt: number;
  changesToken: string;
  syncMode: 'smart' | 'push' | 'pull';
  keepRevisions: boolean;
  // Applies only when keepRevisions is true. After each push, older keepForever
  // revisions beyond these counts are actively deleted (Drive's revisions.update
  // cannot unset keepForever — see driveApi.deleteRevision — so pruning must be
  // done by outright deletion, not by "unpinning" and waiting for GC).
  revisionKeepCount: number;
  binaryRevisionKeepCount: number;
  excludePaths: string[];
  concurrency: number;
}

export const DEFAULT_SETTINGS: NeoSettings = {
  refreshToken: '',
  vaultRootId: '',
  authProxyUrl: 'https://neogdsync-worker.neogdsync.workers.dev',
  lastSyncedAt: 0,
  changesToken: '',
  syncMode: 'smart',
  keepRevisions: true,
  revisionKeepCount: 5,
  binaryRevisionKeepCount: 1,
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

export interface IndexEntry {
  driveId: string;
  driveMtime: string;
  syncedAt: number;
  isFolder: boolean;
}
export interface FileIndex {
  [localPath: string]: IndexEntry;
}

export interface SnapshotEntry {
  mtime: number;
  size: number;
}
export interface Snapshot {
  [localPath: string]: SnapshotEntry;
}

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
  trashed?: boolean;
}

// Shape of a single item in the Drive Changes API response
export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    trashed?: boolean;
  };
}

export interface DriveRevision {
  id: string;
  modifiedTime: string;
  size?: string;
  keepForever?: boolean;
}

export interface ConflictRecord {
  localPath: string;
  localMtime: number;
  driveMtime: string;
  conflictCopyPath: string;
  detectedAt: number;
}
