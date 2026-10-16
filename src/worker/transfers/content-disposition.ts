/**
 * Content-Disposition construction for download/stream responses
 * (architecture §7.2, plan T06).
 *
 * Two rules matter here:
 *   - the filename is a display hint, never a path or an identifier: the
 *     `filename` fallback is a safe ASCII quoted-string and `filename*`
 *     carries the real UTF-8 name per RFC 5987/6266;
 *   - active content types (HTML/SVG/XML/JS) are always delivered as
 *     attachments — they may never be rendered inline on this origin.
 */

export type DispositionMode = 'inline' | 'attachment';

/**
 * MIME types whose payloads can execute or be interpreted as active markup.
 * Any XML-family type (`application/xml`, `text/xml`, `*+xml` such as SVG)
 * and the HTML/JavaScript families are covered.
 */
export function isActiveContentType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0] ?? '';
  if (normalized === '') return false;
  if (
    normalized === 'text/html' ||
    normalized === 'application/xhtml+xml' ||
    normalized === 'image/svg+xml'
  ) {
    return true;
  }
  if (normalized === 'text/xml' || normalized === 'application/xml') {
    return true;
  }
  if (normalized.endsWith('+xml')) return true;
  if (
    normalized.endsWith('javascript') ||
    normalized.endsWith('ecmascript') ||
    normalized === 'text/jscript'
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve the effective disposition: `requested` is the client's preference
 * (?disposition=), but an `inline` request is never honoured for active
 * content — attachment is the only safe answer there.
 */
export function resolveDisposition(
  mimeType: string,
  requested?: DispositionMode,
): DispositionMode {
  if (isActiveContentType(mimeType)) return 'attachment';
  return requested ?? 'inline';
}

const FALLBACK_MAX_CHARS = 150;

/**
 * Safe ASCII filename for the `filename="..."` fallback parameter: printable
 * ASCII only, with `"`, `\`, `/` and every non-ASCII or control character
 * replaced by `_`. The result is display text — slashes and drive-relative
 * tricks can never leak into a client-side path.
 */
export function asciiFallbackFilename(name: string): string {
  let out = '';
  for (const char of name) {
    if (out.length >= FALLBACK_MAX_CHARS) break;
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e || char === '"' || char === '\\' || char === '/') {
      out += '_';
    } else {
      out += char;
    }
  }
  const trimmed = out.trim();
  return trimmed === '' ? 'download' : trimmed;
}

// RFC 5987 attr-char: characters allowed unencoded inside filename*.
function isAttrChar(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x21 || // !
    byte === 0x23 || // #
    byte === 0x24 || // $
    byte === 0x26 || // &
    byte === 0x2b || // +
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5e || // ^
    byte === 0x5f || // _
    byte === 0x60 || // `
    byte === 0x7c || // |
    byte === 0x7e // ~
  );
}

/** RFC 5987 encoding of the UTF-8 filename for `filename*=`. */
export function utf8ExtFilename(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let out = '';
  for (const byte of bytes) {
    out += isAttrChar(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Build the full header value, e.g.
 * `attachment; filename="report_.pdf"; filename*=UTF-8''report%C3%A9.pdf`.
 * An empty/missing display name falls back to `download`.
 */
export function buildContentDisposition(
  mode: DispositionMode,
  filename: string | undefined,
): string {
  const name = filename !== undefined && filename.trim() !== '' ? filename : 'download';
  return `${mode}; filename="${asciiFallbackFilename(name)}"; filename*=UTF-8''${utf8ExtFilename(name)}`;
}
