/** Minimal MIME type lookup by file extension */

const MAP: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  ts: 'application/typescript',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
};

export function fromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MAP[ext] ?? 'application/octet-stream';
}

const TEXT_MIMES = new Set(['application/json', 'application/javascript', 'application/typescript']);

// Attachments (images, PDFs, video, office docs, …) are usually replaced wholesale
// rather than incrementally edited, so they don't benefit from deep revision
// history the way notes do — callers use this to prune their revisions harder.
export function isBinaryMime(mimeType: string): boolean {
  return !mimeType.startsWith('text/') && !TEXT_MIMES.has(mimeType);
}
