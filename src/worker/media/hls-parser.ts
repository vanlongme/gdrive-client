/**
 * Bounded HLS VOD playlist parser (architecture §8.2, plan T13; wave-4 D).
 *
 * The package indexer reads playlist bytes through the SA read provider and
 * resolves every URI-bearing construct to a Drive file by canonical path.
 * This module is pure: it parses one playlist text into its line list and
 * the URI references that must be rewritten, and enforces the v1 subset —
 * unencrypted VOD master/media playlists, TS or fMP4 media, EXT-X-MAP init
 * maps, audio/subtitle rendition playlists and EXT-X-BYTERANGE.
 *
 * Hard rejections (HlsPlaylistError):
 *   - encryption/DRM: EXT-X-KEY METHOD != NONE, EXT-X-SESSION-KEY
 *   - live/LL-HLS: missing EXT-X-ENDLIST on a media playlist,
 *     EXT-X-PLAYLIST-TYPE:EVENT, EXT-X-PART/-PART-INF/-SERVER-CONTROL/
 *     -PRELOAD-HINT/-RENDITION-REPORT/-SKIP/-CONTENT-STEERING
 *   - unsupported URI constructs: absolute URIs, scheme-relative URIs,
 *     absolute paths, query/fragment components, EXT-X-DEFINE variables,
 *     EXT-X-SESSION-DATA URI, I-FRAME-STREAM-INF is kept but every other
 *     unknown #EXT-X-* tag fails closed
 *   - path escapes: '..' that resolves above the package root
 *   - bounds: playlist text > 1 MiB (caller-side byte read is capped too),
 *     > HLS_MAX_REFERENCES references in a single playlist
 */

export const HLS_MAX_PLAYLIST_BYTES = 1024 * 1024;
export const HLS_MAX_PLAYLIST_DEPTH = 4;
export const HLS_MAX_REFERENCES = 10_000;

export type HlsRejectReason =
  /** Encryption, DRM, live/LL-HLS or an unsupported tag/URI construct. */
  | 'unsupported'
  /** Malformed playlist syntax (not an HLS playlist at all). */
  | 'invalid'
  /** Absolute URI, scheme-relative URI or absolute path — leaves the package. */
  | 'uri-external'
  /** A '..' segment escapes above the package root folder. */
  | 'uri-escape'
  /** A documented bound was exceeded. */
  | 'oversize';

export class HlsPlaylistError extends Error {
  readonly reason: HlsRejectReason;
  /** Bounded, token-free detail for media_packages.failure_reason. */
  readonly detail: string;

  constructor(reason: HlsRejectReason, detail: string) {
    super(`hls:${reason}:${detail}`);
    this.name = 'HlsPlaylistError';
    this.reason = reason;
    this.detail = detail.slice(0, 200);
  }
}

export function isHlsPlaylistError(err: unknown): err is HlsPlaylistError {
  return err instanceof HlsPlaylistError;
}

export type HlsRefKind = 'playlist' | 'segment' | 'init';

export interface HlsReference {
  /** Index into ParsedHlsPlaylist.lines of the line carrying the URI. */
  readonly lineIndex: number;
  /** Raw URI text as written in the playlist (after percent-decoding rules). */
  readonly rawUri: string;
  /**
   * Canonical path segments relative to the CONTAINING playlist's folder:
   * decoded, '.' collapsed, '..' resolved within the package root. Joined
   * onto the containing playlist's directory to form the package path.
   */
  readonly segments: readonly string[];
  readonly kind: HlsRefKind;
  /**
   * 'line' — the whole line is the URI (segment or variant). 'attribute' —
   * the URI lives in a quoted URI="..." attribute whose value span is
   * given by valueStart/valueEnd offsets inside the line.
   */
  readonly placement: 'line' | 'attribute';
  /** For placement='attribute': the attribute name (always 'URI'). */
  readonly attribute?: 'URI';
  /** Start/end offsets of the attribute VALUE inside the line (no quotes). */
  readonly valueStart?: number;
  readonly valueEnd?: number;
  /** EXT-X-MEDIA TYPE when the reference came from a rendition tag. */
  readonly mediaType?: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
}

export interface ParsedHlsPlaylist {
  readonly kind: 'master' | 'media';
  /** Raw playlist lines (no CR, no BOM); index i is lines[i]. */
  readonly lines: readonly string[];
  readonly references: readonly HlsReference[];
}

// ---------------------------------------------------------------------------
// Attribute-list parser. RFC 8216 attribute lists are `NAME=VALUE` joined by
// ','; values are either quoted strings (no escapes, no bare '"') or tokens
// without ','. We record the exact span of each value so URI rewriting can
// splice in place without re-serializing untouched attributes.
// ---------------------------------------------------------------------------

export interface HlsAttribute {
  readonly name: string;
  readonly value: string;
  /** Offsets of the value text inside the attribute-list substring. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

const ATTR_NAME = /^[A-Za-z0-9-]+/;

export function parseAttributeList(raw: string, tag: string): HlsAttribute[] {
  const attrs: HlsAttribute[] = [];
  let i = 0;
  while (i < raw.length) {
    const nameMatch = ATTR_NAME.exec(raw.slice(i));
    if (nameMatch === null) {
      throw new HlsPlaylistError('invalid', `${tag}: malformed attribute list`);
    }
    const name = nameMatch[0];
    i += name.length;
    if (raw[i] !== '=') {
      throw new HlsPlaylistError('invalid', `${tag}: attribute ${name} missing =`);
    }
    i += 1;
    let value: string;
    let valueStart: number;
    let valueEnd: number;
    if (raw[i] === '"') {
      i += 1;
      const close = raw.indexOf('"', i);
      if (close < 0) {
        throw new HlsPlaylistError('invalid', `${tag}: unterminated quoted value`);
      }
      value = raw.slice(i, close);
      valueStart = i;
      valueEnd = close;
      i = close + 1;
    } else {
      const end = raw.indexOf(',', i);
      const stop = end < 0 ? raw.length : end;
      value = raw.slice(i, stop);
      valueStart = i;
      valueEnd = stop;
      i = stop;
    }
    attrs.push({ name, value, valueStart, valueEnd });
    if (i < raw.length) {
      if (raw[i] !== ',') {
        throw new HlsPlaylistError('invalid', `${tag}: malformed attribute list`);
      }
      i += 1;
      if (i === raw.length) {
        throw new HlsPlaylistError('invalid', `${tag}: trailing comma`);
      }
    }
  }
  return attrs;
}

function attrsToMap(attrs: readonly HlsAttribute[], tag: string): Map<string, HlsAttribute> {
  const map = new Map<string, HlsAttribute>();
  for (const attr of attrs) {
    if (map.has(attr.name)) {
      throw new HlsPlaylistError('invalid', `${tag}: duplicate attribute ${attr.name}`);
    }
    map.set(attr.name, attr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// URI validation. Only relative URIs inside the package are accepted:
// no scheme (any `x:` prefix), no `//` authority, no leading `/`, no literal
// `?`/`#` (they can never be part of the URI a player would resolve to a
// file), no EXT-X-DEFINE `{$var}` substitution, and no smuggled separators
// or control bytes after percent-decoding. '.' collapses, '..' is allowed
// only while it stays inside the package root (it can still reference a
// sibling directory — the parent walk happens against Drive folder ids).
// ---------------------------------------------------------------------------

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function percentDecode(raw: string, uri: string): string {
  // Strict percent-decoding: malformed escapes fail. Raw UTF-8 names are
  // kept as-is (Drive names are case- and Unicode-preserving, and real
  // playlists carry them unencoded); only decoded control bytes and
  // smuggled separators are rejected by the caller.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HlsPlaylistError('invalid', `malformed percent-encoding in URI '${uri.slice(0, 60)}'`);
  }
  return decoded;
}

/** Characters that are URI metacharacters once decoded — never Drive names we bind. */
const URI_MAGIC_CHARS = /[?#:\\]/;

/**
 * Validate a relative playlist URI and return its canonical segments
 * (decoded, '.' removed, '..' resolved). `base` is the containing
 * playlist's directory segments from the package root — RFC relative
 * resolution runs against it, so '..' may pop base segments but can never
 * climb above the root. Throws on every construct that could leave the
 * package or is outside the supported subset.
 */
export function resolveRelativeUri(
  uri: string,
  tag: string,
  base: readonly string[] = [],
): string[] {
  if (uri === '') {
    throw new HlsPlaylistError('invalid', `${tag}: empty URI`);
  }
  if (uri.length > 4096) {
    throw new HlsPlaylistError('oversize', `${tag}: URI exceeds 4096 characters`);
  }
  if (URI_SCHEME.test(uri) || uri.startsWith('//')) {
    throw new HlsPlaylistError('uri-external', `${tag}: external URI`);
  }
  if (uri.startsWith('/')) {
    throw new HlsPlaylistError('uri-escape', `${tag}: absolute path is not relative`);
  }
  if (uri.includes('?') || uri.includes('#')) {
    throw new HlsPlaylistError('unsupported', `${tag}: query/fragment URI components`);
  }
  if (uri.includes('{$')) {
    // EXT-X-DEFINE variable substitution can never be resolved to a Drive
    // name safely; the tag itself is rejected as well.
    throw new HlsPlaylistError('unsupported', `${tag}: variable substitution`);
  }
  const rawSegments = uri.split('/');
  const out: string[] = [...base];
  for (const rawSegment of rawSegments) {
    const segment = percentDecode(rawSegment, uri);
    if (segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) {
        throw new HlsPlaylistError('uri-escape', `${tag}: '..' escapes the package root`);
      }
      out.pop();
      continue;
    }
    if (
      segment === '' ||
      segment.includes('/') ||
      CONTROL_CHARS.test(segment) ||
      URI_MAGIC_CHARS.test(segment)
    ) {
      throw new HlsPlaylistError('invalid', `${tag}: invalid path segment in URI`);
    }
    out.push(segment);
  }
  if (out.length === 0) {
    throw new HlsPlaylistError('invalid', `${tag}: URI resolves to nothing`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tag handling
// ---------------------------------------------------------------------------

const DECIMAL_INTEGER = /^[0-9]+$/;
const EXTINF_LINE = /^[0-9]+(\.[0-9]*)?(,.*)?$/;

const LL_HLS_TAGS = new Set([
  'EXT-X-SERVER-CONTROL',
  'EXT-X-PART-INF',
  'EXT-X-PART',
  'EXT-X-PRELOAD-HINT',
  'EXT-X-RENDITION-REPORT',
  'EXT-X-SKIP',
  'EXT-X-CONTENT-STEERING',
  'EXT-X-IMAGE-STREAM-INF',
]);

const MEDIA_TYPES = new Set(['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS']);

interface ParseState {
  lines: string[];
  references: HlsReference[];
  sawMasterTag: boolean;
  sawMediaTag: boolean;
  sawEndlist: boolean;
  sawTargetDuration: boolean;
  /** Set on EXT-X-STREAM-INF; the next line must be its URI. */
  pendingVariantUri: boolean;
  lineIndexOfTag: number;
  /** Containing playlist's directory, as canonical segments from the root. */
  baseSegments: readonly string[];
}

function addRef(
  state: ParseState,
  ref: Omit<HlsReference, 'lineIndex'>,
): void {
  state.references.push({ ...ref, lineIndex: state.lineIndexOfTag });
  if (state.references.length > HLS_MAX_REFERENCES) {
    throw new HlsPlaylistError(
      'oversize',
      `playlist exceeds ${HLS_MAX_REFERENCES} references`,
    );
  }
}

function handleTag(state: ParseState, tag: string, rawAttrs: string | undefined): void {
  switch (tag) {
    case 'EXTM3U':
      // Only the first line may carry it; structural checks happen in parse.
      throw new HlsPlaylistError('invalid', 'EXTM3U after the first line');

    case 'EXT-X-VERSION':
    case 'EXT-X-TARGETDURATION':
    case 'EXT-X-MEDIA-SEQUENCE':
    case 'EXT-X-DISCONTINUITY-SEQUENCE': {
      if (rawAttrs === undefined || !DECIMAL_INTEGER.test(rawAttrs.trim())) {
        throw new HlsPlaylistError('invalid', `${tag}: expected a decimal integer`);
      }
      if (tag === 'EXT-X-TARGETDURATION') {
        if (state.sawTargetDuration) {
          throw new HlsPlaylistError('invalid', 'duplicate EXT-X-TARGETDURATION');
        }
        state.sawTargetDuration = true;
        state.sawMediaTag = true;
      }
      return;
    }

    case 'EXT-X-PLAYLIST-TYPE': {
      const value = (rawAttrs ?? '').trim();
      if (value === 'EVENT') {
        throw new HlsPlaylistError('unsupported', 'EXT-X-PLAYLIST-TYPE:EVENT is live');
      }
      if (value !== 'VOD') {
        throw new HlsPlaylistError('invalid', 'EXT-X-PLAYLIST-TYPE must be VOD');
      }
      state.sawMediaTag = true;
      return;
    }

    case 'EXTINF': {
      if (rawAttrs === undefined || !EXTINF_LINE.test(rawAttrs.trim())) {
        throw new HlsPlaylistError('invalid', 'EXTINF: expected a duration');
      }
      state.sawMediaTag = true;
      return;
    }

    case 'EXT-X-BYTERANGE': {
      const value = (rawAttrs ?? '').trim();
      if (!/^[0-9]+(@[0-9]+)?$/.test(value)) {
        throw new HlsPlaylistError('invalid', 'EXT-X-BYTERANGE: expected n[@o]');
      }
      return;
    }

    case 'EXT-X-MAP': {
      const attrs = attrsToMap(
        parseAttributeList(rawAttrs ?? '', 'EXT-X-MAP'),
        'EXT-X-MAP',
      );
      const uri = attrs.get('URI');
      if (uri === undefined || uri.value === '') {
        throw new HlsPlaylistError('invalid', 'EXT-X-MAP: URI is required');
      }
      const byterange = attrs.get('BYTERANGE');
      if (byterange !== undefined && !/^[0-9]+@[0-9]+$/.test(byterange.value)) {
        throw new HlsPlaylistError('invalid', 'EXT-X-MAP: BYTERANGE must be "n@o"');
      }
      for (const attr of attrs.values()) {
        if (attr.name !== 'URI' && attr.name !== 'BYTERANGE') {
          throw new HlsPlaylistError('unsupported', `EXT-X-MAP: unsupported attribute ${attr.name}`);
        }
      }
      const segments = resolveRelativeUri(uri.value, 'EXT-X-MAP', state.baseSegments);
      addRef(state, {
        rawUri: uri.value,
        segments,
        kind: 'init',
        placement: 'attribute',
        attribute: 'URI',
        valueStart: uri.valueStart,
        valueEnd: uri.valueEnd,
      });
      state.sawMediaTag = true;
      return;
    }

    case 'EXT-X-KEY': {
      const attrs = attrsToMap(
        parseAttributeList(rawAttrs ?? '', 'EXT-X-KEY'),
        'EXT-X-KEY',
      );
      const method = attrs.get('METHOD')?.value;
      if (method !== 'NONE') {
        throw new HlsPlaylistError('unsupported', `EXT-X-KEY METHOD=${method ?? '?'} is encrypted/DRM`);
      }
      if (attrs.size !== 1 || (rawAttrs ?? '').trim() !== 'METHOD=NONE') {
        // METHOD=NONE must not carry URI/IV/KEYFORMAT (RFC) — and any URI on
        // a key tag is an encryption construct we do not serve. Quoting the
        // enum is not the RFC form either; accept only the exact token.
        throw new HlsPlaylistError('unsupported', 'EXT-X-KEY METHOD=NONE with extra attributes');
      }
      return;
    }

    case 'EXT-X-SESSION-KEY':
      throw new HlsPlaylistError('unsupported', 'EXT-X-SESSION-KEY is DRM');

    case 'EXT-X-STREAM-INF': {
      if (rawAttrs === undefined || rawAttrs === '') {
        throw new HlsPlaylistError('invalid', 'EXT-X-STREAM-INF: missing attributes');
      }
      const attrs = attrsToMap(parseAttributeList(rawAttrs, 'EXT-X-STREAM-INF'), 'EXT-X-STREAM-INF');
      if (attrs.has('URI')) {
        // A URI attribute on STREAM-INF is an unknown construct (the URI
        // must be the following line); reject rather than silently ignore.
        throw new HlsPlaylistError('unsupported', 'EXT-X-STREAM-INF: URI attribute not supported');
      }
      state.pendingVariantUri = true;
      state.sawMasterTag = true;
      return;
    }

    case 'EXT-X-I-FRAME-STREAM-INF': {
      const attrs = attrsToMap(
        parseAttributeList(rawAttrs ?? '', 'EXT-X-I-FRAME-STREAM-INF'),
        'EXT-X-I-FRAME-STREAM-INF',
      );
      const uri = attrs.get('URI');
      if (uri === undefined || uri.value === '') {
        throw new HlsPlaylistError('invalid', 'EXT-X-I-FRAME-STREAM-INF: URI is required');
      }
      const segments = resolveRelativeUri(uri.value, 'EXT-X-I-FRAME-STREAM-INF', state.baseSegments);
      addRef(state, {
        rawUri: uri.value,
        segments,
        kind: 'playlist',
        placement: 'attribute',
        attribute: 'URI',
        valueStart: uri.valueStart,
        valueEnd: uri.valueEnd,
      });
      state.sawMasterTag = true;
      return;
    }

    case 'EXT-X-MEDIA': {
      const attrs = attrsToMap(
        parseAttributeList(rawAttrs ?? '', 'EXT-X-MEDIA'),
        'EXT-X-MEDIA',
      );
      const type = attrs.get('TYPE')?.value;
      if (type === undefined || !MEDIA_TYPES.has(type)) {
        throw new HlsPlaylistError('invalid', 'EXT-X-MEDIA: unknown or missing TYPE');
      }
      const uri = attrs.get('URI');
      if (uri !== undefined) {
        if (type === 'CLOSED-CAPTIONS') {
          throw new HlsPlaylistError('invalid', 'EXT-X-MEDIA CLOSED-CAPTIONS must not carry URI');
        }
        // Rendition URIs point at media playlists — parsed as children.
        const segments = resolveRelativeUri(uri.value, 'EXT-X-MEDIA', state.baseSegments);
        addRef(state, {
          rawUri: uri.value,
          segments,
          kind: 'playlist',
          placement: 'attribute',
          attribute: 'URI',
          valueStart: uri.valueStart,
          valueEnd: uri.valueEnd,
          mediaType: type as 'AUDIO' | 'VIDEO' | 'SUBTITLES',
        });
      }
      state.sawMasterTag = true;
      return;
    }

    case 'EXT-X-SESSION-DATA': {
      const attrs = attrsToMap(
        parseAttributeList(rawAttrs ?? '', 'EXT-X-SESSION-DATA'),
        'EXT-X-SESSION-DATA',
      );
      if (attrs.has('URI')) {
        throw new HlsPlaylistError('unsupported', 'EXT-X-SESSION-DATA URI is external data');
      }
      state.sawMasterTag = true;
      return;
    }

    case 'EXT-X-ENDLIST': {
      if (rawAttrs !== undefined && rawAttrs.trim() !== '') {
        throw new HlsPlaylistError('invalid', 'EXT-X-ENDLIST: unexpected attributes');
      }
      state.sawEndlist = true;
      state.sawMediaTag = true;
      return;
    }

    case 'EXT-X-INDEPENDENT-SEGMENTS':
    case 'EXT-X-DISCONTINUITY':
    case 'EXT-X-GAP':
    case 'EXT-X-I-FRAMES-ONLY': {
      if (rawAttrs !== undefined && rawAttrs !== '') {
        throw new HlsPlaylistError('invalid', `${tag}: unexpected attributes`);
      }
      if (tag === 'EXT-X-I-FRAMES-ONLY' || tag === 'EXT-X-GAP' || tag === 'EXT-X-DISCONTINUITY') {
        state.sawMediaTag = true;
      }
      return;
    }

    case 'EXT-X-DATERANGE': {
      // Parsed as a real attribute list: any *-URI attribute is a URI
      // construct we do not serve; 'URI=' inside a quoted value is metadata.
      const attrs = parseAttributeList(rawAttrs ?? '', 'EXT-X-DATERANGE');
      for (const attr of attrs) {
        if (attr.name === 'URI' || attr.name.endsWith('-URI')) {
          throw new HlsPlaylistError('unsupported', 'EXT-X-DATERANGE: URI construct not supported');
        }
      }
      state.sawMediaTag = true;
      return;
    }

    case 'EXT-X-START':
    case 'EXT-X-PROGRAM-DATE-TIME':
    case 'EXT-X-BITRATE':
    case 'EXT-X-AVERAGE-BANDWIDTH': {
      // Harmless non-URI metadata.
      if (rawAttrs !== undefined && rawAttrs.includes('URI=')) {
        throw new HlsPlaylistError('unsupported', `${tag}: URI construct not supported`);
      }
      if (tag !== 'EXT-X-START') {
        state.sawMediaTag = true;
      }
      return;
    }

    case 'EXT-X-DEFINE':
      throw new HlsPlaylistError('unsupported', 'EXT-X-DEFINE variable substitution');

    default: {
      if (LL_HLS_TAGS.has(tag)) {
        throw new HlsPlaylistError('unsupported', `${tag} is live/low-latency HLS`);
      }
      if (tag.startsWith('EXT-X-')) {
        throw new HlsPlaylistError('unsupported', `unknown tag ${tag}`);
      }
      // Non-EXT-X '#' lines are comments (RFC 8216 §4.1).
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const LINE_SPLIT = /\r\n|\r|\n/;

/**
 * Parse one playlist text. `text` must already be UTF-8-decoded and the
 * caller must have applied the byte bound before decoding; the check is
 * repeated on the decoded length so a caller that skipped it still fails.
 */
export function parseHlsPlaylist(
  text: string,
  baseSegments: readonly string[] = [],
): ParsedHlsPlaylist {
  if (new TextEncoder().encode(text).byteLength > HLS_MAX_PLAYLIST_BYTES) {
    throw new HlsPlaylistError('oversize', 'playlist exceeds 1 MiB');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const lines = text.split(LINE_SPLIT);
  if (lines.length === 0 || lines[0] !== '#EXTM3U') {
    throw new HlsPlaylistError('invalid', 'missing #EXTM3U header');
  }

  const state: ParseState = {
    lines,
    references: [],
    sawMasterTag: false,
    sawMediaTag: false,
    sawEndlist: false,
    sawTargetDuration: false,
    pendingVariantUri: false,
    lineIndexOfTag: 0,
    baseSegments,
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    state.lineIndexOfTag = i;

    if (line.startsWith('#')) {
      if (state.pendingVariantUri) {
        throw new HlsPlaylistError('invalid', 'EXT-X-STREAM-INF must be followed by a URI line');
      }
      const colon = line.indexOf(':');
      const tag = colon < 0 ? line.slice(1) : line.slice(1, colon);
      const rawAttrs = colon < 0 ? undefined : line.slice(colon + 1);
      handleTag(state, tag, rawAttrs);
      continue;
    }

    // Non-tag line: a URI.
    const uri = line.trim();
    if (state.pendingVariantUri) {
      state.pendingVariantUri = false;
      const segments = resolveRelativeUri(uri, 'EXT-X-STREAM-INF', state.baseSegments);
      addRef(state, {
        rawUri: uri,
        segments,
        kind: 'playlist',
        placement: 'line',
      });
      state.sawMasterTag = true;
      continue;
    }
    const segments = resolveRelativeUri(uri, 'segment', state.baseSegments);
    addRef(state, {
      rawUri: uri,
      segments,
      kind: 'segment',
      placement: 'line',
    });
    state.sawMediaTag = true;
  }

  if (state.pendingVariantUri) {
    throw new HlsPlaylistError('invalid', 'EXT-X-STREAM-INF must be followed by a URI line');
  }
  if (state.sawMasterTag && state.sawMediaTag) {
    throw new HlsPlaylistError('invalid', 'playlist mixes master and media tags');
  }
  if (!state.sawMasterTag && !state.sawMediaTag) {
    throw new HlsPlaylistError('invalid', 'playlist carries no media or variants');
  }
  if (state.sawMasterTag) {
    if (state.references.length === 0) {
      throw new HlsPlaylistError('invalid', 'master playlist has no playable renditions');
    }
    return { kind: 'master', lines, references: state.references };
  }
  if (!state.sawEndlist) {
    throw new HlsPlaylistError('unsupported', 'media playlist without EXT-X-ENDLIST is live');
  }
  if (!state.sawTargetDuration) {
    throw new HlsPlaylistError('invalid', 'media playlist requires EXT-X-TARGETDURATION');
  }
  return { kind: 'media', lines, references: state.references };
}

// ---------------------------------------------------------------------------
// URI rewriting. Every reference is replaced by the resource-route URI the
// caller supplies — a missing mapping is a generation inconsistency, never
// a silent pass-through of the original Drive-relative URI.
// ---------------------------------------------------------------------------

/**
 * Rewrite all URI references in `parsed` using `uriFor`. Returns the full
 * rewritten playlist text (LF line endings). `uriFor` must return a value
 * for every reference; throwing propagates.
 */
export function rewriteHlsPlaylist(
  parsed: ParsedHlsPlaylist,
  uriFor: (ref: HlsReference) => string,
): string {
  const lines = [...parsed.lines];
  for (const ref of parsed.references) {
    const replacement = uriFor(ref);
    const line = lines[ref.lineIndex];
    if (line === undefined) {
      throw new HlsPlaylistError('invalid', 'reference index out of range');
    }
    if (ref.placement === 'line') {
      lines[ref.lineIndex] = replacement;
    } else {
      if (ref.valueStart === undefined || ref.valueEnd === undefined) {
        throw new HlsPlaylistError('invalid', 'attribute reference lacks span');
      }
      // valueStart/valueEnd are offsets inside the attribute-list
      // substring (the text after the tag's first ':').
      const colon = line.indexOf(':');
      const start = colon + 1 + ref.valueStart;
      const end = colon + 1 + ref.valueEnd;
      lines[ref.lineIndex] = `${line.slice(0, start)}${replacement}${line.slice(end)}`;
    }
  }
  return lines.join('\n');
}
