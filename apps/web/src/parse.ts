/**
 * Parsing user-typed text into the solver's integer units (cents, basis
 * points). Purely textual — no float multiplication, so "123.45" becomes
 * exactly 12345 cents. Returns null for text that isn't a valid amount;
 * callers keep the previous good value and mark the field invalid.
 */

/** "1,234.56" | "$1,234.56" | "0.5" | "" (= 0) -> integer cents, or null. */
export function parseDollarsToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (cleaned === "") return 0;
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** "40" | "12.5" | "0.25" | "" (= 0) -> integer basis points, or null. */
export function parsePercentToBps(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (cleaned === "") return 0;
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Integer cents -> plain editable text like "1234.56" ("" for 0). */
export function centsToText(cents: number): string {
  if (cents === 0) return "";
  const whole = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100);
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

/** Integer basis points -> plain editable percent text like "12.5" ("" for 0). */
export function bpsToText(bps: number): string {
  if (bps === 0) return "";
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  if (fraction === 0) return String(whole);
  const two = String(fraction).padStart(2, "0");
  return `${whole}.${two.replace(/0$/, "")}`;
}
