/**
 * Display formatting for catalog data. Sizes are decimal strings in the
 * contract; bigint arithmetic only (plan global constraints).
 */

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(decimal: string, locale: string): string {
  let value: bigint;
  try {
    value = BigInt(decimal);
  } catch {
    return decimal;
  }
  if (value < 0n) return decimal;
  let unit = 0;
  let scaled = value;
  // Divide through bigint until under 1024, then render one decimal at most.
  while (scaled >= 1024n && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024n;
    unit += 1;
  }
  const rendered = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(scaled);
  return `${rendered} ${BYTE_UNITS[unit]}`;
}

export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
