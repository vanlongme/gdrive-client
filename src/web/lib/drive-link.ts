/**
 * Extracts a Drive folder id from what an admin pastes into the mount form.
 * Pure and offline: the pasted link is NEVER fetched. The server stays the
 * authority (it answers MOUNT_ROOT_NOT_FOLDER for a file id), so this only
 * refuses input that clearly is not a drive.google.com folder reference.
 *
 * Accepted: a bare id, /drive/folders/<id>, /drive/u/N/folders/<id>,
 * /drive/mobile/folders/<id>, open?id=<id> and the legacy folderview?id=<id>,
 * with or without scheme, query string, fragment or trailing slash.
 * Rejected: other hosts (including docs.google.com), file/document paths,
 * the My Drive home, ids outside the Drive id charset, oversized input.
 */
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;
const DRIVE_HOST = "drive.google.com";
const MAX_INPUT_LENGTH = 2048;

function asDriveId(candidate: string | null | undefined): string | null {
  return candidate !== null &&
    candidate !== undefined &&
    DRIVE_ID_PATTERN.test(candidate)
    ? candidate
    : null;
}

function toUrl(text: string): URL | null {
  for (const candidate of [text, `https://${text}`]) {
    try {
      return new URL(candidate);
    } catch {
      // try the next shape
    }
  }
  return null;
}

export function parseDriveFolderInput(input: string): string | null {
  const text = input.trim();
  if (text === "" || text.length > MAX_INPUT_LENGTH) return null;

  const bare = asDriveId(text);
  if (bare !== null) return bare;

  const url = toUrl(text);
  if (url === null) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== DRIVE_HOST) return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const foldersAt = segments.lastIndexOf("folders");
  if (foldersAt !== -1) return asDriveId(segments[foldersAt + 1]);

  if (
    segments.length === 1 &&
    (segments[0] === "open" || segments[0] === "folderview")
  ) {
    return asDriveId(url.searchParams.get("id"));
  }
  return null;
}
