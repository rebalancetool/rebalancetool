import { DEFAULT_TOLERANCE_BPS } from "@rebalancer/solver";
import type { Scenario } from "@rebalancer/solver";

/**
 * Rendering-time formatting only. Money stays integer cents everywhere in
 * the app; these helpers are the single place cents become display strings.
 */

export function formatCents(cents: number): string {
  const dollars = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "-" : ""}$${dollars}`;
}

/** "+$400.00" / "-$400.00", or an em dash for zero (no change). */
export function formatDelta(cents: number): string {
  if (cents === 0) return "—";
  return `${cents > 0 ? "+" : ""}${formatCents(cents)}`;
}

/** Basis points as a percentage, e.g. 2550 -> "25.5%". */
export function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}%`;
}

/** Signed deviation like "+1.2%" (for basis-point deviations from target). */
export function formatSignedBpsAsPercent(bps: number): string {
  return `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
}

/**
 * The one-line settings summary in the status bar above the results. Every
 * solver setting lives behind ⚙ Settings, so this line is what keeps
 * tucked-away settings from invisibly shaping the results: the selling
 * posture is *always* stated — it's the setting with tax consequences —
 * and the other knobs are listed whenever they differ from the page's
 * defaults.
 */
export function describeOptions(options: Scenario["options"]): string {
  const notes: string[] = [];
  if (!(options?.allowSelling ?? false)) notes.push("selling off");
  else if (options?.sellInTaxableAccounts ?? false) notes.push("selling on", "may sell in taxable accounts");
  else notes.push("selling on", "taxable accounts protected");
  if (options?.optimizeAssetLocation ?? false) notes.push("optimizing asset location");
  const tolerance = options?.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  if (tolerance !== DEFAULT_TOLERANCE_BPS) notes.push(`tolerance ±${formatBpsAsPercent(tolerance)}`);
  const minTrade = options?.minTradeCents ?? 0;
  if (minTrade > 0) notes.push(`min trade ${formatCents(minTrade)}`);
  return notes.join(" · ");
}
