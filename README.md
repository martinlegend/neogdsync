# NeoGDSync

Lightweight Google Drive sync plugin for [Obsidian](https://obsidian.md).

## Features

- **Smart Sync** — auto conflict detection, only syncs changed files
- **Force Push** — local vault → Google Drive
- **Force Pull** — Google Drive → local vault
- **Conflict handling** — saves Drive copy as a conflict file, never overwrites silently
- **Path-based index** — fast, no full crawl needed after first sync
- **Version history** — optionally keep file revisions on Drive
- **Configurable excludes** — glob patterns to skip files/folders
- **URI handler** — `obsidian://neogdsync?mode=smart|push|pull` for automation

## Setup

1. Install the plugin
2. Go to **Settings → NeoGDSync**
3. Enter your **Google OAuth2 Refresh Token**
4. Enter your **Google Drive Vault Root Folder ID** (the Drive folder that maps to your vault root)
5. Click the ☁ ribbon icon or run a command to sync

## Getting a Refresh Token

This plugin uses a standard OAuth2 refresh token with read/write access to Google Drive.

You can obtain one via:
- The [Google Drive for Desktop](https://www.google.com/drive/download/) OAuth flow
- Any OAuth2 tool using scope `https://www.googleapis.com/auth/drive`

The token is stored locally in your vault's plugin data and never leaves your device except to authenticate with Google.

## Commands

| Command | Description |
|---------|-------------|
| Smart Sync | Detect and sync only changed files, with conflict detection |
| Force Push | Upload all local changes to Drive |
| Force Pull | Download all Drive changes to local |
| Rebuild Drive Index | Re-crawl Drive vault folder to rebuild index |
| Show Conflicts | View detected conflicts |

## URI Handler

Trigger sync from outside Obsidian (Shortcuts, scripts, etc.):

```
obsidian://neogdsync?mode=smart
obsidian://neogdsync?mode=push
obsidian://neogdsync?mode=pull
```

## License

MIT
