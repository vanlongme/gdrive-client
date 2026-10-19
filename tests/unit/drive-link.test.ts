import { describe, expect, it } from "vitest";

import { parseDriveFolderInput } from "../../src/web/lib/drive-link";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";

/**
 * Review Focus #3: pasted Drive URL variants must parse to an id or be
 * rejected clearly. The server still rejects non-folder ids with
 * MOUNT_ROOT_NOT_FOLDER (Task 3 integration test); this parser only
 * extracts a plausible id and refuses anything that is clearly not a
 * drive.google.com folder reference.
 */
describe("parseDriveFolderInput", () => {
  it.each<[string, string, string]>([
    ["a bare id", ID, ID],
    ["a bare id with surrounding whitespace", `  ${ID}\n`, ID],
    ["a Shared Drive style id", "0AKvQ1abCdEfGhIjKlMn", "0AKvQ1abCdEfGhIjKlMn"],
    ["the standard folder URL", `https://drive.google.com/drive/folders/${ID}`, ID],
    ["a folder URL with ?usp=sharing", `https://drive.google.com/drive/folders/${ID}?usp=sharing`, ID],
    ["an account-indexed URL", `https://drive.google.com/drive/u/1/folders/${ID}?usp=sharing`, ID],
    ["an account-indexed URL with resourcekey", `https://drive.google.com/drive/u/0/folders/${ID}?resourcekey=0-AbC_d`, ID],
    ["a mobile URL", `https://drive.google.com/drive/mobile/folders/${ID}`, ID],
    ["a trailing slash and fragment", `https://drive.google.com/drive/folders/${ID}/#details`, ID],
    ["a scheme-less URL", `drive.google.com/drive/folders/${ID}`, ID],
    ["an http URL", `http://drive.google.com/drive/folders/${ID}`, ID],
    ["open?id=", `https://drive.google.com/open?id=${ID}`, ID],
    ["open?id= with other params first", `https://drive.google.com/open?usp=sharing&id=${ID}`, ID],
    ["the legacy folderview URL", `https://drive.google.com/folderview?id=${ID}&usp=sharing`, ID],
  ])("accepts %s", (_name, input, expected) => {
    expect(parseDriveFolderInput(input)).toBe(expected);
  });

  it.each<[string, string]>([
    ["a Google Docs document URL", `https://docs.google.com/document/d/${ID}/edit`],
    ["a Docs-host folders path", `https://docs.google.com/drive/folders/${ID}`],
    ["a Drive file URL", `https://drive.google.com/file/d/${ID}/view`],
    ["the My Drive home URL", "https://drive.google.com/drive/my-drive"],
    ["the account-indexed My Drive home URL", "https://drive.google.com/drive/u/0/my-drive"],
    ["a foreign host", `https://example.com/drive/folders/${ID}`],
    ["a look-alike host", `https://drive.google.com.evil.test/drive/folders/${ID}`],
    ["a userinfo host trick", `https://drive.google.com@evil.test/drive/folders/${ID}`],
    ["a javascript: URL", "javascript:alert(1)"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["free text", "hello world"],
    ["a sentence", "not a link at all"],
    ["a too-short bare id", "abc123"],
    ["a too-short id inside a folder URL", "https://drive.google.com/drive/folders/abc"],
    ["illegal characters", "abc$%^defghijk"],
    ["open without an id", "https://drive.google.com/open"],
    ["a folders segment without an id", "https://drive.google.com/drive/folders/"],
    ["a percent-encoded id segment", `https://drive.google.com/drive/folders/${ID}%2Fx`],
    ["oversized input", "a".repeat(5000)],
  ])("rejects %s", (_name, input) => {
    expect(parseDriveFolderInput(input)).toBeNull();
  });
});
