import {
  Plugin, Notice, TFile, TAbstractFile,
  PluginSettingTab, App, Setting, Modal, ButtonComponent,
} from 'obsidian';
import type { SettingDefinitionItem, SettingDefinitionRender, SettingGroup } from 'obsidian';
import { NeoSettings, DEFAULT_SETTINGS, PendingOps, ConflictRecord, Snapshot } from './types';
import { DriveApi } from './driveApi';
import { PathIndex } from './pathIndex';
import { VaultSnapshot } from './snapshot';
import { Syncer, SyncResult, normFolder } from './syncer';
import { isExcluded } from './exclude';
import { clearTokenCache, DEFAULT_PROXY_URL } from './auth';

// Lives under .neogdsync/ so it is excluded from sync (see exclude()).
const ERROR_LOG_PATH = '.neogdsync/sync-errors.log';

export default class NeoGDSync extends Plugin {
  settings!: NeoSettings;
  pendingOps: PendingOps = {};
  conflicts: ConflictRecord[] = [];

  drive!: DriveApi;
  index!: PathIndex;
  snapshot!: VaultSnapshot;
  private syncing = false;
  // Paths written by the sync run currently in flight; vault events for these
  // are echoes of our own writes and must be ignored. User edits made during a
  // sync are NOT in this set, so they still queue up normally.
  private activeSyncWrites?: ReadonlySet<string>;
  private statusEl?: HTMLElement;

  // ── Lifecycle ──────────────────────────────────────────────────

  async onload() {
    this.snapshot = new VaultSnapshot(this.app);
    await this.loadSettings();

    this.drive = new DriveApi(this.settings.refreshToken, this.settings.authProxyUrl);
    this.index = new PathIndex(this.app, this.drive, this.settings.vaultRootId);
    await this.index.load();

    // Delay both offline diff AND event registration until layout is ready.
    // Before onLayoutReady, vault.getFiles() returns stale stat values.
    this.app.workspace.onLayoutReady(() => {
      console.debug(`[NeoGDSync] onLayoutReady: vault has ${this.app.vault.getFiles().length} files`);
      this.mergeOfflineDiff();
      this.registerEvents();
    });

    const ribbonIcon = this.addRibbonIcon('cloud', 'Sync vault', () => this.openSyncModal());
    ribbonIcon.addClass('neogdsync-ribbon');

    this.statusEl = this.addStatusBarItem();
    this.updateStatus();

    this.addCommand({ id: 'smart-sync',    name: 'Smart sync (auto conflict detect)', callback: () => this.runSync('smart') });
    this.addCommand({ id: 'force-push',    name: 'Force push (local → drive)',         callback: () => this.runSync('push') });
    this.addCommand({ id: 'force-pull',    name: 'Force pull (drive → local)',          callback: () => this.runSync('pull') });
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild drive index',                 callback: () => this.rebuildIndex() });
    this.addCommand({ id: 'show-conflicts', name: 'Show conflicts',                     callback: () => this.showConflicts() });

    this.addSettingTab(new NeoSettingsTab(this.app, this));

    this.registerObsidianProtocolHandler('neogdsync', (params) => {
      const mode = params.mode === 'push' ? 'push' : params.mode === 'pull' ? 'pull' : 'smart';
      void this.runSync(mode);
    });

    new Notice('Sync plugin loaded');
  }

  onunload() {
    // snapshot.save() MUST come before saveSettings() so fresh stats are persisted.
    // onunload must return void (Plugin contract); the async tail is fire-and-forget.
    window.clearTimeout(this.saveTimer);
    this.snapshot.save(p => this.exclude(p));
    void this.saveSettings().then(() => this.index.save());
  }

  // ── Vault events ───────────────────────────────────────────────

  private registerEvents() {
    this.registerEvent(this.app.vault.on('create', f => this.handleCreate(f)));
    this.registerEvent(this.app.vault.on('modify', f => this.handleModify(f)));
    this.registerEvent(this.app.vault.on('delete', f => this.handleDelete(f)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.handleRename(f, old)));
  }

  exclude(path: string): boolean {
    return isExcluded(path, this.app.vault.configDir, this.settings.excludePaths);
  }

  private handleCreate(f: TAbstractFile) {
    if (this.activeSyncWrites?.has(f.path)) return;
    if (this.exclude(f.path)) return;
    if (!(f instanceof TFile)) return;
    const cur = this.pendingOps[f.path];
    if (cur === 'delete') {
      this.pendingOps[f.path] = 'modify';
    } else if (!cur) {
      this.pendingOps[f.path] = 'create';
    }
    this.updateStatus();
    this.debouncedSave();
  }

  private handleModify(f: TAbstractFile) {
    if (this.activeSyncWrites?.has(f.path)) return;
    if (this.exclude(f.path) || !(f instanceof TFile)) return;
    const snap = this.snapshot.get(f.path);
    if (snap && Math.abs(f.stat.mtime - snap.mtime) <= 2000 && f.stat.size === snap.size) return;
    if (!this.pendingOps[f.path]) {
      this.pendingOps[f.path] = 'modify';
    }
    this.updateStatus();
    this.debouncedSave();
  }

  private handleDelete(f: TAbstractFile) {
    if (this.activeSyncWrites?.has(f.path)) return;
    if (this.exclude(f.path)) return;
    if (this.pendingOps[f.path] === 'create') {
      delete this.pendingOps[f.path];
    } else {
      this.pendingOps[f.path] = 'delete';
    }
    this.index.delete(f.path);
    this.updateStatus();
    this.debouncedSave();
  }

  private handleRename(f: TAbstractFile, oldPath: string) {
    if (this.exclude(f.path) && this.exclude(oldPath)) return;
    // Folders don't need an explicit push op — they're created on-demand by resolveParentFolder.
    // Registering a folder rename as 'create' causes it to get stuck in pendingOps forever
    // because handlePush early-returns on TFolder without clearing the entry.
    if (!(f instanceof TFile)) {
      this.index.rename(oldPath, f.path);
      this.updateStatus();
      this.debouncedSave();
      return;
    }
    if (this.pendingOps[oldPath] === 'create') {
      delete this.pendingOps[oldPath];
      this.pendingOps[f.path] = 'create';
    } else {
      this.pendingOps[oldPath] = 'delete';
      this.pendingOps[f.path] = 'create';
    }
    this.index.rename(oldPath, f.path);
    this.updateStatus();
    this.debouncedSave();
  }

  private mergeOfflineDiff() {
    const snapData = this.snapshot.getAll();
    const snapCount = Object.keys(snapData).length;
    console.debug(`[NeoGDSync] mergeOfflineDiff: snapshot=${snapCount}, vault=${this.app.vault.getFiles().length}`);

    if (snapCount === 0) {
      console.debug('[NeoGDSync] No snapshot — saving current vault as baseline');
      this.snapshot.save(p => this.exclude(p));
      void this.saveSettings();
      // Baseline means existing files won't be treated as offline creates, so a
      // fresh install with a non-empty vault must be initialized explicitly.
      if (this.app.vault.getFiles().length > 0 && this.index.allPaths().length === 0) {
        new Notice('NeoGDSync: first run — use Force Push (or Force Pull) once to initialize sync', 10000);
      }
      return;
    }

    const diff = this.snapshot.computeDiff(p => this.exclude(p));
    const diffEntries = Object.entries(diff);
    console.debug(`[NeoGDSync] computeDiff: ${diffEntries.length} ops`);

    for (const [path, op] of diffEntries.slice(0, 5)) {
      const f = this.app.vault.getAbstractFileByPath(path);
      const snap = snapData[path];
      if (f instanceof TFile && snap) {
        console.debug(`[NeoGDSync]   ${op}: ${path} mtime diff=${f.stat.mtime - snap.mtime}ms size: ${snap.size}→${f.stat.size}`);
      } else {
        console.debug(`[NeoGDSync]   ${op}: ${path} f=${!!f} snap=${!!snap}`);
      }
    }

    let count = 0;
    for (const [path, op] of diffEntries) {
      if (!this.pendingOps[path]) { this.pendingOps[path] = op; count++; }
    }
    console.debug(count > 0
      ? `[NeoGDSync] Startup diff: ${count} offline changes`
      : '[NeoGDSync] Startup diff: 0 changes — snapshot is current');
    this.updateStatus();
  }

  // ── Sync ───────────────────────────────────────────────────────

  async runSync(mode: 'smart' | 'push' | 'pull', folderFilter?: string) {
    if (this.syncing) { new Notice('Sync already in progress'); return; }
    if (!this.settings.refreshToken) { new Notice('No refresh token configured'); return; }

    const folder = folderFilter ? normFolder(folderFilter) : undefined;
    this.syncing = true;
    this.updateStatus('Syncing…');
    const notice = new Notice(folder ? `Sync ${folder}…` : 'Sync started…', 0);

    try {
      const syncer = new Syncer(
        this.app, this.drive, this.index, this.snapshot,
        this.settings, this.pendingOps,
        (msg: string) => { notice.setMessage(msg); },
      );
      this.activeSyncWrites = syncer.syncWrites;

      let result: SyncResult;
      if (mode === 'push') result = await syncer.forcePush(folder);
      else if (mode === 'pull') result = await syncer.forcePull(folder);
      else result = await syncer.smartSync();

      this.conflicts.push(...result.conflicts);
      this.settings.lastSyncedAt = Date.now();
      await this.saveSettings();
      await this.index.save();

      const summary = `↑${result.pushed.length} ↓${result.pulled.length} 🗑${result.deleted.length}` +
        (result.conflicts.length ? ` ⚠️${result.conflicts.length} conflicts` : '') +
        (result.errors.length ? ` ❌${result.errors.length} errors` : '');
      notice.setMessage(`Done — ${summary}`);
      window.setTimeout(() => notice.hide(), 4000);

      if (result.errors.length) {
        console.error('[NeoGDSync] Errors:', result.errors);
        await this.logSyncFailure(mode, result);
        // Wholesale failure (e.g. network/auth outage during the scheduled 5am sync) used to
        // vanish into a 4-second notice nobody saw — 2026-07-12: 714 ops all errored silently.
        const succeeded = result.pushed.length + result.pulled.length + result.deleted.length;
        if (succeeded === 0 && result.errors.length >= 10) {
          new Notice(
            `NeoGDSync: sync failed wholesale — ${result.errors.length} errors, 0 succeeded.\n` +
            `First: ${result.errors[0].error.slice(0, 120)}\n` +
            `Details in ${ERROR_LOG_PATH} (click to dismiss)`,
            0,
          );
        }
      }
      if (result.conflicts.length) new Notice(`${result.conflicts.length} conflict(s) detected`, 6000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notice.setMessage(`Sync error: ${msg}`);
      window.setTimeout(() => notice.hide(), 5000);
      console.error('[NeoGDSync]', err);
      await this.logSyncFailure(mode, null, msg);
      this.syncing = false;
      this.activeSyncWrites = undefined;
      this.updateStatus();
      return;
    }

    // Keep suppression active for 600ms so vault events fired by writeLocal/modifyBinary
    // (which fire asynchronously) are still matched against syncWrites. Then re-save
    // snapshot with fresh TFile stats.
    window.setTimeout(() => {
      this.snapshot.save(p => this.exclude(p));
      void this.saveSettings().finally(() => {
        this.syncing = false;
        this.activeSyncWrites = undefined;
        this.updateStatus();
      });
    }, 600);
  }

  /**
   * Persist sync failures to .neogdsync/sync-errors.log (excluded from sync) so scheduled
   * syncs that fail while nobody is watching leave a durable trace. `result` is null when
   * the sync aborted with an exception before producing a result.
   */
  private async logSyncFailure(mode: string, result: SyncResult | null, fatal?: string) {
    try {
      const adapter = this.app.vault.adapter;
      const ts = new Date().toISOString();
      const lines: string[] = [];
      if (result) {
        const succeeded = result.pushed.length + result.pulled.length + result.deleted.length;
        lines.push(`[${ts}] mode=${mode} errors=${result.errors.length} succeeded=${succeeded}`);
        for (const e of result.errors.slice(0, 5)) lines.push(`  ${e.path}: ${e.error.slice(0, 200)}`);
        if (result.errors.length > 5) lines.push(`  … ${result.errors.length - 5} more`);
      } else {
        lines.push(`[${ts}] mode=${mode} FATAL: ${(fatal ?? 'unknown').slice(0, 300)}`);
      }
      const prev = (await adapter.exists(ERROR_LOG_PATH)) ? await adapter.read(ERROR_LOG_PATH) : '';
      // Keep the log bounded: retain roughly the last 500 lines.
      const merged = (prev + lines.join('\n') + '\n').split('\n');
      const trimmed = merged.length > 500 ? merged.slice(merged.length - 500) : merged;
      await adapter.write(ERROR_LOG_PATH, trimmed.join('\n'));
    } catch (logErr) {
      console.error('[NeoGDSync] could not write sync-errors.log', logErr);
    }
  }

  async rebuildIndex() {
    if (this.syncing) { new Notice('Sync in progress'); return; }
    this.syncing = true;
    const notice = new Notice('Rebuilding drive index…', 0);
    try {
      await this.index.rebuild(msg => notice.setMessage(msg));
      notice.setMessage('Drive index rebuilt');
      window.setTimeout(() => notice.hide(), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notice.setMessage(`Rebuild failed: ${msg}`);
      window.setTimeout(() => notice.hide(), 5000);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  showConflicts() { new ConflictModal(this.app, this).open(); }
  openSyncModal() { new SyncModal(this.app, this).open(); }

  // ── Status bar ─────────────────────────────────────────────────

  updateStatus(override?: string) {
    if (!this.statusEl) return;
    if (override) { this.statusEl.setText(`☁ ${override}`); return; }
    const n = Object.keys(this.pendingOps).length;
    const c = this.conflicts.length;
    let txt = n > 0 ? `☁ ${n} pending` : '☁ synced';
    if (c > 0) txt += ` ⚠️${c}`;
    this.statusEl.setText(txt);
  }

  // ── Settings ───────────────────────────────────────────────────

  private saveTimer?: number;
  debouncedSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.saveSettings(); }, 500);
  }

  async loadSettings() {
    const saved = await this.loadData() as {
      settings?: Partial<NeoSettings>;
      pendingOps?: PendingOps;
      conflicts?: ConflictRecord[];
      snapshot?: Snapshot;
    } | null;
    this.settings   = Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {});
    this.pendingOps = saved?.pendingOps ?? {};
    this.conflicts  = saved?.conflicts ?? [];
    if (this.snapshot) this.snapshot.setRaw(saved?.snapshot);

    // Migrate: replace legacy proxy URLs with current self-hosted Worker
    const legacyUrls = [
      'https://ogd.richardxiong.com/api/access',
      'https://neogdsync-oauth.neogdsync.workers.dev',
    ];
    if (legacyUrls.includes(this.settings.authProxyUrl)) {
      this.settings.authProxyUrl = DEFAULT_SETTINGS.authProxyUrl;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData({
      settings:   this.settings,
      pendingOps: this.pendingOps,
      conflicts:  this.conflicts,
      snapshot:   this.snapshot ? this.snapshot.getAll() : {},
    });
  }
}

// ── Sync Modal ────────────────────────────────────────────────

class SyncModal extends Modal {
  constructor(app: App, private plugin: NeoGDSync) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Sync' });

    const pending = Object.keys(this.plugin.pendingOps).length;
    contentEl.createEl('p', { text: `Pending operations: ${pending}` });
    if (pending > 0) {
      const ul = contentEl.createEl('ul');
      for (const [p, op] of Object.entries(this.plugin.pendingOps).slice(0, 20)) {
        ul.createEl('li', { text: `${op}: ${p}` });
      }
      if (pending > 20) ul.createEl('li', { text: `… and ${pending - 20} more` });
    }

    // Folder filter input
    const filterRow = contentEl.createDiv({ cls: 'neogdsync-filter-row' });
    filterRow.createEl('label', { text: 'Folder (optional): ', attr: { for: 'neogdsync-folder-input' } });
    const folderInput = filterRow.createEl('input', {
      cls: 'neogdsync-folder-input',
      attr: { id: 'neogdsync-folder-input', type: 'text', placeholder: 'e.g. 2026/2026-04' },
    });

    const getFolder = () => folderInput.value.trim() || undefined;

    const btnRow = contentEl.createDiv({ cls: 'neogdsync-btn-row' });
    btnRow.createEl('button', { text: 'Smart sync' }).onclick  = () => { this.close(); void this.plugin.runSync('smart'); };
    btnRow.createEl('button', { text: 'Force push' }).onclick   = () => { this.close(); void this.plugin.runSync('push', getFolder()); };
    btnRow.createEl('button', { text: 'Force pull' }).onclick   = () => { this.close(); void this.plugin.runSync('pull', getFolder()); };
    if (this.plugin.conflicts.length > 0) {
      btnRow.createEl('button', { text: `${this.plugin.conflicts.length} conflicts` })
        .onclick = () => { this.close(); this.plugin.showConflicts(); };
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ── Conflict Modal ─────────────────────────────────────────────

class ConflictModal extends Modal {
  constructor(app: App, private plugin: NeoGDSync) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Conflicts' });
    const conflicts = this.plugin.conflicts;
    if (!conflicts.length) { contentEl.createEl('p', { text: 'No conflicts.' }); return; }
    for (const c of conflicts) {
      const div = contentEl.createDiv({ cls: 'neogdsync-conflict' });
      div.createEl('strong', { text: c.localPath });
      div.createEl('br');
      div.createEl('small', { text: `Local: ${new Date(c.localMtime).toLocaleString()} | Drive: ${new Date(c.driveMtime).toLocaleString()}` });
      div.createEl('br');
      div.createEl('small', { text: `Drive copy saved as: ${c.conflictCopyPath}` });
    }
    contentEl.createEl('hr');
    contentEl.createEl('button', { text: 'Clear all conflicts' })
      .onclick = async () => {
        this.plugin.conflicts = [];
        await this.plugin.saveSettings();
        this.close();
        new Notice('Conflicts cleared');
      };
  }

  onClose() { this.contentEl.empty(); }
}

// ── Settings Tab ───────────────────────────────────────────────

type SettingRow = Pick<SettingDefinitionRender, 'name' | 'desc' | 'aliases' | 'visible'> & {
  render: (setting: Setting, group: SettingGroup) => unknown;
};

/** `setDestructive()` replaces `setWarning()` on Obsidian 1.13+; keep the old call for 1.6–1.12. */
function markDestructive(b: ButtonComponent): ButtonComponent {
  const withNew = b as ButtonComponent & { setDestructive?: () => ButtonComponent };
  return typeof withNew.setDestructive === 'function' ? withNew.setDestructive() : b.setWarning();
}

class NeoSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: NeoGDSync) { super(app, plugin); }

  /** Re-render after state changes: `update()` on 1.13+, full `display()` before that. */
  private refresh() {
    if (typeof this.update === 'function') this.update();
    else this.display();
  }

  /** Declarative rows (Obsidian 1.13+): makes every setting reachable from settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.rows().map(({ render, ...rest }) => ({
      ...rest,
      render: (setting: Setting, group: SettingGroup) => { render(setting, group); },
    }));
  }

  /** Imperative fallback for Obsidian < 1.13, which never calls getSettingDefinitions(). */
  display() {
    const { containerEl } = this;
    containerEl.empty();
    for (const row of this.rows()) {
      if (row.visible === false) continue;
      const setting = new Setting(containerEl);
      setting.setName(row.name);
      if (row.desc) setting.setDesc(row.desc);
      // Only the 1.13+ host passes a group; rows ignore it.
      row.render(setting, undefined as unknown as SettingGroup);
    }
  }

  private rows(): SettingRow[] {
    const plugin = this.plugin;
    const settings = plugin.settings;
    const isConnected = !!settings.refreshToken;
    const toPositiveInt = (v: string) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 1 ? n : null;
    };

    return [
      {
        name: 'Google Drive',
        desc: isConnected ? '✅ Connected — token saved' : 'Not connected',
        aliases: ['connect', 'authorize', 'oauth', 'disconnect'],
        render: s => {
          if (isConnected) {
            s.addButton(b => markDestructive(b.setButtonText('Disconnect')).onClick(async () => {
              plugin.settings.refreshToken = '';
              plugin.drive.setAuth('', plugin.settings.authProxyUrl);
              clearTokenCache();
              await plugin.saveSettings();
              this.refresh();
            }));
          } else {
            s.addButton(b => b.setButtonText('Connect Google Drive').setCta().onClick(() => {
              window.open(`${plugin.settings.authProxyUrl}/authorize`, '_blank');
              this.refresh();
            }));
          }
        },
      },
      {
        name: 'Refresh token',
        desc: isConnected ? 'Token is set. Re-paste to update.' : 'Complete "Connect" above, then paste the token here.',
        aliases: ['token', 'credentials'],
        render: s => {
          let tokenInputEl: HTMLInputElement | undefined;
          s.addText(t => {
            // Masked by default — this token grants full read/write/delete access to the
            // user's Drive, and settings tabs are commonly captured in screenshots/screen shares.
            t.inputEl.type = 'password';
            tokenInputEl = t.inputEl;
            t.setPlaceholder('1//05o…').setValue(plugin.settings.refreshToken)
              .onChange(async v => {
                plugin.settings.refreshToken = v.trim();
                plugin.drive.setAuth(v.trim(), plugin.settings.authProxyUrl);
                clearTokenCache();
                await plugin.saveSettings();
              });
          }).addExtraButton(b => b
            .setIcon('eye')
            .setTooltip('Show/hide token')
            .onClick(() => {
              if (!tokenInputEl) return;
              tokenInputEl.type = tokenInputEl.type === 'password' ? 'text' : 'password';
            }));
        },
      },
      {
        name: 'Vault root folder ID',
        desc: 'Google Drive folder ID that is the root of this vault. Change requires plugin reload.',
        aliases: ['drive folder', 'root'],
        render: s => s.addText(t => {
          t.inputEl.addClass('neogdsync-monospace-input');
          t.setPlaceholder('Root folder ID').setValue(plugin.settings.vaultRootId)
            .onChange(async v => {
              plugin.settings.vaultRootId = v.trim();
              plugin.index = new PathIndex(plugin.app, plugin.drive, v.trim());
              await plugin.index.load();
              await plugin.saveSettings();
            });
        }),
      },
      {
        name: 'Auth proxy URL',
        desc: 'OAuth token-refresh proxy. Leave as default, or point to your own deployment of oauth-proxy/worker.js (see the README on self-hosting).',
        aliases: ['proxy', 'worker', 'self-host', 'cloudflare'],
        render: s => s.addText(t => {
          t.inputEl.addClass('neogdsync-monospace-input');
          t.setPlaceholder(DEFAULT_PROXY_URL).setValue(plugin.settings.authProxyUrl)
            .onChange(async v => {
              plugin.settings.authProxyUrl = v.trim() || DEFAULT_PROXY_URL;
              plugin.drive.setAuth(plugin.settings.refreshToken, plugin.settings.authProxyUrl);
              clearTokenCache();
              await plugin.saveSettings();
            });
        }),
      },
      {
        name: 'Excluded paths',
        desc: 'Glob patterns to skip, one per line (e.g. Templates/**, **/*.tmp).',
        aliases: ['exclude', 'ignore', 'glob'],
        render: s => s.addTextArea(t => {
          t.inputEl.rows = 5;
          t.inputEl.addClass('neogdsync-monospace-input');
          t.setValue(plugin.settings.excludePaths.join('\n'))
            .onChange(async v => {
              plugin.settings.excludePaths = v.split('\n').map(x => x.trim()).filter(Boolean);
              await plugin.saveSettings();
            });
        }),
      },
      {
        name: 'Sync mode',
        desc: 'Default sync mode when using ribbon icon',
        render: s => s.addDropdown(d => d
          .addOption('smart', 'Smart (conflict detect)')
          .addOption('push', 'Force push')
          .addOption('pull', 'Force pull')
          .setValue(plugin.settings.syncMode)
          .onChange(async v => {
            plugin.settings.syncMode = v as NeoSettings['syncMode'];
            await plugin.saveSettings();
          })),
      },
      {
        name: 'Keep revisions',
        desc: 'Keep file revisions on drive (version history)',
        aliases: ['version history'],
        render: s => s.addToggle(t => t.setValue(plugin.settings.keepRevisions)
          .onChange(async v => {
            plugin.settings.keepRevisions = v;
            await plugin.saveSettings();
            this.refresh();
          })),
      },
      {
        name: 'Revisions to keep — notes',
        desc: 'After each push, older pinned revisions of text/Markdown files beyond this count are permanently deleted (drive cannot "unpin" a revision, only delete it).',
        visible: settings.keepRevisions,
        render: s => s.addText(t => t.setValue(String(plugin.settings.revisionKeepCount))
          .onChange(async v => {
            const n = toPositiveInt(v);
            if (n !== null) { plugin.settings.revisionKeepCount = n; await plugin.saveSettings(); }
          })),
      },
      {
        name: 'Revisions to keep — attachments',
        desc: 'Same, but for binary attachments (images, PDFs, office docs, …). These are usually replaced wholesale rather than edited, so a lower count is recommended.',
        visible: settings.keepRevisions,
        render: s => s.addText(t => t.setValue(String(plugin.settings.binaryRevisionKeepCount))
          .onChange(async v => {
            const n = toPositiveInt(v);
            if (n !== null) { plugin.settings.binaryRevisionKeepCount = n; await plugin.saveSettings(); }
          })),
      },
      {
        name: 'Pending ops',
        desc: `${Object.keys(plugin.pendingOps).length} files queued`,
        aliases: ['queue'],
        render: s => s.addButton(b => b.setButtonText('Clear all').onClick(async () => {
          plugin.pendingOps = {};
          await plugin.saveSettings();
          plugin.updateStatus();
          this.refresh();
        })),
      },
      {
        name: 'Rebuild drive index',
        desc: 'Crawl drive vault from root and rebuild local index',
        render: s => s.addButton(b => b.setButtonText('Rebuild').onClick(() => { void plugin.rebuildIndex(); })),
      },
      {
        name: `Last sync: ${settings.lastSyncedAt ? new Date(settings.lastSyncedAt).toLocaleString() : 'never'}`,
        desc: `Conflicts: ${plugin.conflicts.length}`,
        aliases: ['status', 'conflicts'],
        render: () => { /* informational row */ },
      },
    ];
  }
}
