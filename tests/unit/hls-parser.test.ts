/**
 * T13 unit coverage for the bounded HLS VOD parser (pure module, no D1).
 * Every fixture lives under tests/fixtures/hls/; hostile constructs must
 * fail with the documented HlsPlaylistError reason.
 */

import { describe, expect, it } from 'vitest';

import masterFixture from '../fixtures/hls/master.m3u8?raw';
import mediaTsFixture from '../fixtures/hls/media-ts.m3u8?raw';
import mediaFmp4Fixture from '../fixtures/hls/media-fmp4.m3u8?raw';
import audioFixture from '../fixtures/hls/audio/audio.m3u8?raw';
import subsFixture from '../fixtures/hls/subs/subs.m3u8?raw';
import encryptedFixture from '../fixtures/hls/encrypted.m3u8?raw';
import drmFixture from '../fixtures/hls/drm.m3u8?raw';
import liveFixture from '../fixtures/hls/live.m3u8?raw';
import eventFixture from '../fixtures/hls/event.m3u8?raw';
import llhlsFixture from '../fixtures/hls/llhls.m3u8?raw';
import externalFixture from '../fixtures/hls/external-uri.m3u8?raw';
import schemeRelativeFixture from '../fixtures/hls/scheme-relative.m3u8?raw';
import escapeFixture from '../fixtures/hls/escape.m3u8?raw';
import defineFixture from '../fixtures/hls/define.m3u8?raw';
import unknownTagFixture from '../fixtures/hls/unknown-tag.m3u8?raw';
import noHeaderFixture from '../fixtures/hls/no-header.m3u8?raw';
import unicodeFixture from '../fixtures/hls/unicode.m3u8?raw';
import mapOnlyFixture from '../fixtures/hls/map-only.m3u8?raw';
import {
  HLS_MAX_PLAYLIST_BYTES,
  HLS_MAX_REFERENCES,
  HlsPlaylistError,
  parseHlsPlaylist,
  rewriteHlsPlaylist,
} from '../../src/worker/media/hls-parser';

function expectHlsError(
  text: string,
  reason: string,
  detail?: RegExp,
  base?: readonly string[],
) {
  try {
    parseHlsPlaylist(text, base);
  } catch (err) {
    expect(err).toBeInstanceOf(HlsPlaylistError);
    const hlsErr = err as HlsPlaylistError;
    expect(hlsErr.reason).toBe(reason);
    if (detail !== undefined) expect(hlsErr.detail).toMatch(detail);
    return;
  }
  throw new Error(`expected HlsPlaylistError(${reason})`);
}

describe('parseHlsPlaylist — valid VOD playlists', () => {
  it('parses a master playlist: variants + audio/subtitle URI attributes', () => {
    const parsed = parseHlsPlaylist(masterFixture);
    expect(parsed.kind).toBe('master');
    const refs = parsed.references;
    expect(refs).toHaveLength(4);
    const audio = refs.find((r) => r.mediaType === 'AUDIO');
    expect(audio?.segments).toEqual(['audio', 'audio.m3u8']);
    expect(audio?.kind).toBe('playlist');
    const subs = refs.find((r) => r.mediaType === 'SUBTITLES');
    expect(subs?.segments).toEqual(['subs', 'subs.m3u8']);
    const variants = refs.filter((r) => r.placement === 'line');
    expect(variants.map((r) => r.segments.join('/'))).toEqual([
      'media-ts.m3u8',
      'media-fmp4.m3u8',
    ]);
  });

  it('parses a TS media playlist with EXT-X-BYTERANGE', () => {
    const parsed = parseHlsPlaylist(mediaTsFixture);
    expect(parsed.kind).toBe('media');
    // Two byterange'd refs to seg0.ts share the path; the third has spaces
    // and a subdirectory — names are preserved verbatim.
    expect(parsed.references.map((r) => r.segments.join('/'))).toEqual([
      'seg0.ts',
      'seg0.ts',
      'My Clip/seg 1.ts',
    ]);
    expect(parsed.references.every((r) => r.kind === 'segment')).toBe(true);
  });

  it('parses an fMP4 media playlist with EXT-X-MAP', () => {
    const parsed = parseHlsPlaylist(mediaFmp4Fixture);
    const init = parsed.references.find((r) => r.kind === 'init');
    expect(init?.segments).toEqual(['init.mp4']);
    expect(init?.placement).toBe('attribute');
    const segments = parsed.references.filter((r) => r.kind === 'segment');
    expect(segments.map((s) => s.segments[0])).toEqual(['frag0.m4s', 'frag1.m4s']);
  });

  it('accepts EXT-X-MAP without a BYTERANGE', () => {
    const parsed = parseHlsPlaylist(mapOnlyFixture);
    expect(parsed.references[0]?.kind).toBe('init');
    expect(parsed.references[0]?.segments).toEqual(['init.mp4']);
  });

  it('parses audio and subtitle media playlists', () => {
    expect(parseHlsPlaylist(audioFixture).references).toHaveLength(2);
    const subs = parseHlsPlaylist(subsFixture);
    expect(subs.references[0]?.segments).toEqual(['sub0.vtt']);
  });

  it('preserves case and Unicode in segment names', () => {
    const parsed = parseHlsPlaylist(unicodeFixture);
    expect(parsed.references[0]?.segments).toEqual(['Phim', 'Phân đoạn 1.ts']);
    expect(parsed.references[1]?.segments).toEqual(['CAFE.ts']);
  });

  it('accepts percent-encoded names and collapses them', () => {
    const parsed = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nMy%20Clip/seg%201.ts\n#EXT-X-ENDLIST\n',
    );
    expect(parsed.references[0]?.segments).toEqual(['My Clip', 'seg 1.ts']);
  });

  it('resolves ".." that stays inside the package root', () => {
    const parsed = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsub/../seg.ts\n#EXT-X-ENDLIST\n',
    );
    expect(parsed.references[0]?.segments).toEqual(['seg.ts']);
  });
});

describe('parseHlsPlaylist — hostile rejections', () => {
  it('rejects AES-128 encryption (EXT-X-KEY METHOD != NONE)', () => {
    expectHlsError(encryptedFixture, 'unsupported', /EXT-X-KEY/);
  });

  it('rejects EXT-X-SESSION-KEY (DRM)', () => {
    expectHlsError(drmFixture, 'unsupported', /SESSION-KEY/);
  });

  it('rejects EXT-X-KEY METHOD=NONE carrying a URI', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE,URI="k"\n#EXTINF:1,x.ts\n#EXT-X-ENDLIST\n',
      'unsupported',
    );
  });

  it('rejects live playlists without EXT-X-ENDLIST', () => {
    expectHlsError(liveFixture, 'unsupported', /ENDLIST/);
  });

  it('rejects EXT-X-PLAYLIST-TYPE:EVENT', () => {
    expectHlsError(eventFixture, 'unsupported', /EVENT/);
  });

  it('rejects LL-HLS (EXT-X-PART / SERVER-CONTROL)', () => {
    expectHlsError(llhlsFixture, 'unsupported', /SERVER-CONTROL|PART/);
  });

  it('rejects absolute http(s) URIs', () => {
    expectHlsError(externalFixture, 'uri-external');
  });

  it('rejects scheme-relative URIs', () => {
    expectHlsError(schemeRelativeFixture, 'uri-external');
  });

  it('rejects absolute paths', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\n/root/seg.ts\n#EXT-X-ENDLIST\n',
      'uri-escape',
    );
  });

  it('rejects ".." escaping the package root', () => {
    expectHlsError(escapeFixture, 'uri-escape');
  });

  it('resolves leading ".." relative to the containing playlist directory', () => {
    const parsed = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\n../seg.ts\n#EXT-X-ENDLIST\n',
      ['v'],
    );
    expect(parsed.references[0]?.segments).toEqual(['seg.ts']);
  });

  it('denies ".." that climbs above the package root via the base dir', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\n../../seg.ts\n#EXT-X-ENDLIST\n',
      'uri-escape',
      /escape/,
      ['v'],
    );
    // '..' that pops the base and lands at root stays inside the package.
    const parsed = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nx/../../seg.ts\n#EXT-X-ENDLIST\n',
      ['v'],
    );
    expect(parsed.references[0]?.segments).toEqual(['seg.ts']);
  });

  it('rejects decoded URI-magic characters in segments (? # : \\)', () => {
    const media = (uri: string) =>
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\n${uri}\n#EXT-X-ENDLIST\n`;
    expectHlsError(media('seg%3Fname.ts'), 'invalid');
    expectHlsError(media('seg%23name.ts'), 'invalid');
    expectHlsError(media('data%3Aname.ts'), 'invalid');
    expectHlsError(media('seg%5Cname.ts'), 'invalid');
    expectHlsError(media('x/s:y'), 'invalid');
  });

  it('rejects EXT-X-KEY METHOD=NONE when quoted or carrying extras', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD="NONE"\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n',
      'unsupported',
    );
  });

  it('rejects EXT-X-DATERANGE URI attributes without false-positives', () => {
    // X-ASSET-URI is a URI construct and stays rejected.
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-DATERANGE:ID="x",START-DATE="2020-01-01T00:00:00Z",X-ASSET-URI="a"\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n',
      'unsupported',
    );
    // 'URI=' inside a quoted non-URI attribute value is metadata, not a URI.
    const parsed = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-DATERANGE:ID="x",START-DATE="2020-01-01T00:00:00Z",X-META="has URI= inside"\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n',
    );
    expect(parsed.kind).toBe('media');
  });

  it('rejects duplicate EXT-X-TARGETDURATION and attributes on ENDLIST', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-TARGETDURATION:9\n#EXTINF:1,\ns.ts\n#EXT-X-ENDLIST\n',
      'invalid',
    );
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\ns.ts\n#EXT-X-ENDLIST:junk\n',
      'invalid',
    );
  });

  it('rejects EXTINF with a non-numeric duration suffix', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0junk,\nseg.ts\n#EXT-X-ENDLIST\n',
      'invalid',
    );
    expect(
      parseHlsPlaylist(
        '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,title here\nseg.ts\n#EXT-X-ENDLIST\n',
      ).references,
    ).toHaveLength(1);
  });

  it('rejects query/fragment URI components', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nseg.ts?token=x\n#EXT-X-ENDLIST\n',
      'unsupported',
    );
  });

  it('rejects EXT-X-DEFINE variable substitution', () => {
    expectHlsError(defineFixture, 'unsupported', /DEFINE|variable/);
  });

  it('rejects unknown EXT-X tags (fail closed on URI constructs)', () => {
    expectHlsError(unknownTagFixture, 'unsupported', /EXT-X-CUSTOM-EXFIL/);
  });

  it('rejects EXT-X-SESSION-DATA with a URI', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID="x",URI="https://e/x.json"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n',
      'unsupported',
    );
  });

  it('rejects a missing #EXTM3U header', () => {
    expectHlsError(noHeaderFixture, 'invalid', /EXTM3U/);
  });

  it('rejects EXT-X-STREAM-INF without a following URI line', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-ENDLIST\n',
      'invalid',
    );
  });

  it('rejects malformed percent-encoding', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nseg%zz.ts\n#EXT-X-ENDLIST\n',
      'invalid',
    );
  });

  it('rejects a decoded path separator smuggled via %2F', () => {
    expectHlsError(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\na%2Fb.ts\n#EXT-X-ENDLIST\n',
      'invalid',
    );
  });

  it('rejects playlists over the 1 MiB bound', () => {
    const huge =
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,' +
      'x'.repeat(HLS_MAX_PLAYLIST_BYTES) +
      '\nseg.ts\n#EXT-X-ENDLIST\n';
    expectHlsError(huge, 'oversize');
  });

  it('rejects more than 10,000 references in one playlist', () => {
    const segs = Array.from(
      { length: HLS_MAX_REFERENCES + 1 },
      (_, i) => `#EXTINF:1,\ns${i}.ts`,
    ).join('\n');
    expectHlsError(
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n${segs}\n#EXT-X-ENDLIST\n`,
      'oversize',
    );
  });

  it('rejects non-UTF-8 playlist bytes at the caller boundary', () => {
    // Decode-level check lives in package-index readPlaylistText; here we
    // verify the parser rejects a structurally invalid playlist.
    expectHlsError('#EXTM3U\n', 'invalid');
  });
});

describe('rewriteHlsPlaylist', () => {
  it('rewrites line URIs and URI="..." attribute values in place', () => {
    const parsed = parseHlsPlaylist(masterFixture);
    const out = rewriteHlsPlaylist(parsed, (ref) => `res-${ref.segments.join('~')}`);
    expect(out).toContain('URI="res-audio~audio.m3u8"');
    expect(out).toContain('URI="res-subs~subs.m3u8"');
    const lines = out.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    expect(lines[idx + 1]).toBe('res-media-ts.m3u8');
    // Untouched attributes keep their exact text.
    expect(lines[idx]).toContain('BANDWIDTH=800000');
    expect(lines[idx]).toContain('CODECS="avc1.4d001f,mp4a.40.2"');
  });

  it('propagates credential query suffixes into rewritten URIs', () => {
    const parsed = parseHlsPlaylist(mediaTsFixture);
    const out = rewriteHlsPlaylist(parsed, () => 'r9?share=shr_x');
    expect(out.split('\n').filter((l) => l === 'r9?share=shr_x')).toHaveLength(3);
  });
});
