/** Minimal runtime stub of the `obsidian` module for unit tests. */

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export class TAbstractFile {
  path = '';
  name = '';
}

export class TFile extends TAbstractFile {
  stat = { mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {}

export class Notice {
  constructor(_message?: string, _timeout?: number) {}
  setMessage(_message: string) {}
  hide() {}
}

export class Plugin {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class App {}

export async function requestUrl(): Promise<never> {
  throw new Error('requestUrl is not available in unit tests');
}
