import {
  Plugin, Notice, TFile, TAbstractFile,
  PluginSettingTab, App, Setting, Modal,
} from 'obsidian';
import { NeoSettings, DEFAULT_SETTINGS, PendingOps, ConflictRecord, Snapshot } from './types';
import { DriveApi } from './driveApi';
import { PathIndex } from './pathIndex';
import { VaultSnapshot } from './snapshot';
import { Syncer, SyncResult } from './syncer';
import { clearTokenCache } from './auth';

export default class NeoGDSync extends Plugin {
  settings!: NeoSettings;
  pendingOps: PendingOps = {};
  conflicts: ConflictRecord[] = [];

  drive!: DriveApi;
  index!: PathIndex;
  snapshot!: VaultSnapshot;
  private syncing = false;
  private statusEl?: HTMLElement;

  // ── Lifecycle ──────────────────────────────────────────────────

  async onload() {
    this.snapshot = new VaultSnapshot(this.app);
    await this.loadSettings();

    this.drive = new DriveApi(this.settings.refreshToken);
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

  async onunload() {
    // snapshot.save() MUST come before saveSettings() so fresh stats are persisted
    this.snapshot.save(p => this.exclude(p));
    await this.saveSettings();
    await this.index.save();
  }

  // ── Vault events ───────────────────────────────────────────────

  private registerEvents() {
    this.registerEvent(this.app.vault.on('create', f => this.handleCreate(f)));
    this.registerEvent(this.app.vault.on('modify', f => this.handleModify(f)));
    this.registerEvent(this.app.vault.on('delete', f => this.handleDelete(f)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.handleRename(f, old)));
  }

  exclude(path: string): boolean {
    if (path.startsWith('.neogdsync'))       return true;
    if (path.startsWith(this.app.vault.configDir)) return true;
    if (path.startsWith('.smart-env'))       return true;
    if (path.startsWith('.smtcmp'))          return true;
    if (path.endsWith('.DS_Store'))          return true;
    return false;
  }

  private handleCreate(f: TAbstractFile) {
    if (this.syncing) return;
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
    if (this.syncing) return;
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

  async runSync(mode: 'smart' | 'push' | 'pull') {
    if (this.syncing) { new Notice('Sync already in progress'); return; }
    if (!this.settings.refreshToken) { new Notice('No refresh token configured'); return; }

    this.syncing = true;
    this.updateStatus('Syncing…');
    const notice = new Notice('Sync started…', 0);

    try {
      const syncer = new Syncer(
        this.app, this.drive, this.index, this.snapshot,
        this.settings, this.pendingOps,
        (msg: string) => { notice.setMessage(msg); },
      );

      let result: SyncResult;
      if (mode === 'push') result = await syncer.forcePush();
      else if (mode === 'pull') result = await syncer.forcePull();
      else result = await syncer.smartSync();

      this.conflicts.push(...result.conflicts);
      this.settings.lastSyncedAt = Date.now();
      await this.saveSettings();
      await this.index.save();

      const summary = `↑${result.pushed.length} ↓${result.pulled.length} 🗑${result.deleted.length}` +
        (result.conflicts.length ? ` ⚠️${result.conflicts.length} conflicts` : '') +
        (result.errors.length ? ` ❌${result.errors.length} errors` : '');
      notice.setMessage(`Done — ${summary}`);
      setTimeout(() => notice.hide(), 4000);

      if (result.errors.length) console.error('[NeoGDSync] Errors:', result.errors);
      if (result.conflicts.length) new Notice(`${result.conflicts.length} conflict(s) detected`, 6000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notice.setMessage(`Sync error: ${msg}`);
      setTimeout(() => notice.hide(), 5000);
      console.error('[NeoGDSync]', err);
      this.syncing = false;
      this.updateStatus();
      return;
    }

    // Keep syncing=true for 600ms so vault events fired by writeLocal/modifyBinary
    // (which fire asynchronously) are still suppressed. Then re-save snapshot with
    // fresh TFile stats.
    setTimeout(() => {
      this.snapshot.save(p => this.exclude(p));
      void this.saveSettings().finally(() => {
        this.syncing = false;
        this.updateStatus();
      });
    }, 600);
  }

  async rebuildIndex() {
    if (this.syncing) { new Notice('Sync in progress'); return; }
    this.syncing = true;
    const notice = new Notice('Rebuilding drive index…', 0);
    try {
      await this.index.rebuild(msg => notice.setMessage(msg));
      notice.setMessage('Drive index rebuilt');
      setTimeout(() => notice.hide(), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notice.setMessage(`Rebuild failed: ${msg}`);
      setTimeout(() => notice.hide(), 5000);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  showConflicts() { new ConflictModal(this.app, this.conflicts).open(); }
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

  private saveTimer?: ReturnType<typeof setTimeout>;
  debouncedSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.saveSettings(); }, 500);
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

    const btnRow = contentEl.createDiv({ cls: 'neogdsync-btn-row' });
    btnRow.createEl('button', { text: 'Smart sync' }).onclick  = () => { this.close(); void this.plugin.runSync('smart'); };
    btnRow.createEl('button', { text: 'Force push' }).onclick   = () => { this.close(); void this.plugin.runSync('push'); };
    btnRow.createEl('button', { text: 'Force pull' }).onclick   = () => { this.close(); void this.plugin.runSync('pull'); };
    if (this.plugin.conflicts.length > 0) {
      btnRow.createEl('button', { text: `${this.plugin.conflicts.length} conflicts` })
        .onclick = () => { this.close(); this.plugin.showConflicts(); };
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ── Conflict Modal ─────────────────────────────────────────────

class ConflictModal extends Modal {
  constructor(app: App, private conflicts: ConflictRecord[]) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Conflicts' });
    if (!this.conflicts.length) { contentEl.createEl('p', { text: 'No conflicts.' }); return; }
    for (const c of this.conflicts) {
      const div = contentEl.createDiv({ cls: 'neogdsync-conflict' });
      div.createEl('strong', { text: c.localPath });
      div.createEl('br');
      div.createEl('small', { text: `Local: ${new Date(c.localMtime).toLocaleString()} | Drive: ${new Date(c.driveMtime).toLocaleString()}` });
      div.createEl('br');
      div.createEl('small', { text: `Drive copy saved as: ${c.conflictCopyPath}` });
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ── Settings Tab ───────────────────────────────────────────────

class NeoSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: NeoGDSync) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setHeading();

    new Setting(containerEl)
      .setName('Refresh token')
      .setDesc('Refresh token for Google Drive')
      .addText(t => t.setPlaceholder('1//05o…').setValue(this.plugin.settings.refreshToken)
        .onChange(async v => {
          this.plugin.settings.refreshToken = v.trim();
          this.plugin.drive = new DriveApi(v.trim());
          clearTokenCache();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Vault root folder ID')
      .setDesc('Google Drive folder ID that is the root of this vault. Change requires plugin reload.')
      .addText(t => {
        t.inputEl.addClass('neogdsync-monospace-input');
        t.setPlaceholder('Root folder ID').setValue(this.plugin.settings.vaultRootId)
          .onChange(async v => {
            this.plugin.settings.vaultRootId = v.trim();
            this.plugin.index = new PathIndex(this.plugin.app, this.plugin.drive, v.trim());
            await this.plugin.index.load();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Sync mode').setDesc('Default sync mode when using ribbon icon')
      .addDropdown(d => d
        .addOption('smart', 'Smart (conflict detect)')
        .addOption('push', 'Force push')
        .addOption('pull', 'Force pull')
        .setValue(this.plugin.settings.syncMode)
        .onChange(async v => {
          this.plugin.settings.syncMode = v as NeoSettings['syncMode'];
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Keep revisions').setDesc('Keep file revisions on drive (version history)')
      .addToggle(t => t.setValue(this.plugin.settings.keepRevisions)
        .onChange(async v => { this.plugin.settings.keepRevisions = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Pending ops').setDesc(`${Object.keys(this.plugin.pendingOps).length} files queued`)
      .addButton(b => b.setButtonText('Clear all').onClick(async () => {
        this.plugin.pendingOps = {};
        await this.plugin.saveSettings();
        this.plugin.updateStatus();
        this.display();
      }));

    new Setting(containerEl)
      .setName('Rebuild drive index').setDesc('Crawl drive vault from root and rebuild local index')
      .addButton(b => b.setButtonText('Rebuild').onClick(() => { void this.plugin.rebuildIndex(); }));

    new Setting(containerEl).setName('Status').setHeading();
    new Setting(containerEl)
      .setName(`Last sync: ${this.plugin.settings.lastSyncedAt ? new Date(this.plugin.settings.lastSyncedAt).toLocaleString() : 'never'}`)
      .setDesc(`Conflicts: ${this.plugin.conflicts.length}`);
  }
}
