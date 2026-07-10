import type { TaxPreference, TaxType } from "./types.ts";

/**
 * The allocation seam.
 *
 * rebalance() reduces its input to a TransportationProblem in
 * (account × asset class) space — ids and integer cents only; funds, trade
 * construction, and warning wording stay in rebalance.ts. allocate() decides
 * the final placement x[a][c] under the one hard constraint that money never
 * leaves an account: each account's post-trade total is fixed at
 * Σ_c current[a][c] + cash[a] (a fixed-supply transportation problem).
 *
 * The current implementation is the greedy waterfall described atop
 * rebalance.ts. Swapping in a different optimizer (e.g. an LP) later means
 * replacing allocate() alone — same signature, nothing else moves.
 *
 * Determinism: results never depend on the order of the input arrays or map
 * entries; every choice ties off to a stable id comparison.
 */

export interface ProblemAccount {
  id: string;
  taxType: TaxType;
  /**
   * Asset class that absorbs this account's leftover contribution cash once
   * every reachable gap is closed (the class of the account's most-preferred
   * fund). Undefined only when the account offers no funds at all —
   * rebalance() rejects such an account up front whenever it has cash.
   */
  fallbackAssetClassId: string | undefined;
}

export interface ProblemAssetClass {
  id: string;
  taxPreference: TaxPreference;
}

export interface TransportationProblem {
  accounts: ProblemAccount[];
  assetClasses: ProblemAssetClass[];
  /** Uninvested contribution cash per account id, integer cents. */
  cash: Map<string, number>;
  /** G[c]: target dollars per asset class id at the post-contribution total. */
  demands: Map<string, number>;
  /** H[a][c]: current dollars per account id per asset class id. */
  current: Map<string, Map<string, number>>;
  /** Whether purchases of the asset class can land in the account. */
  buyable: (accountId: string, assetClassId: string) => boolean;
}

export type AllocationWarning =
  | { kind: "unreachable_gap"; assetClassId: string; remainingGap: number }
  | { kind: "leftover_cash"; accountId: string; assetClassId: string; amount: number };

export interface Allocation {
  /** x[a][c]: final dollars per account per asset class; Σ_c x[a][c] = Σ_c current[a][c] + cash[a]. */
  x: Map<string, Map<string, number>>;
  /** Emission order: unreachable gaps in waterfall order, then leftovers in account-id order. */
  warnings: AllocationWarning[];
}

export function allocate(problem: TransportationProblem): Allocation {
  const accounts = [...problem.accounts].sort((a, b) => a.id.localeCompare(b.id));
  const assetClasses = [...problem.assetClasses].sort((a, b) => a.id.localeCompare(b.id));
  const taxPreferenceByClass = new Map(assetClasses.map((c) => [c.id, c.taxPreference]));

  const x = new Map<string, Map<string, number>>();
  const cash = new Map<string, number>();
  for (const account of accounts) {
    x.set(account.id, new Map(problem.current.get(account.id) ?? []));
    cash.set(account.id, problem.cash.get(account.id) ?? 0);
  }

  // Remaining under-target gap per asset class, at the whole-portfolio level.
  const gap = new Map<string, number>();
  for (const assetClass of assetClasses) {
    const demand = problem.demands.get(assetClass.id) ?? 0;
    let held = 0;
    for (const account of accounts) held += x.get(account.id)!.get(assetClass.id) ?? 0;
    gap.set(assetClass.id, Math.max(0, demand - held));
  }

  const warnings: AllocationWarning[] = [];
  const blocked = new Set<string>();

  // Buy pass: drain the biggest gap first, from the best eligible account.
  while (true) {
    let bestAssetClassId: string | null = null;
    let bestGap = 0;
    for (const [assetClassId, g] of gap) {
      if (g <= 0 || blocked.has(assetClassId)) continue;
      if (g > bestGap || (g === bestGap && (bestAssetClassId === null || assetClassId < bestAssetClassId))) {
        bestGap = g;
        bestAssetClassId = assetClassId;
      }
    }
    if (bestAssetClassId === null) break;

    const preference = taxPreferenceByClass.get(bestAssetClassId) ?? "neutral";
    const eligible = accounts
      .filter((account) => (cash.get(account.id) ?? 0) > 0 && problem.buyable(account.id, bestAssetClassId!))
      .sort((a, b) => {
        const rankA = taxTypeRank(preference, a.taxType);
        const rankB = taxTypeRank(preference, b.taxType);
        if (rankA !== rankB) return rankA - rankB;
        return a.id.localeCompare(b.id);
      });

    if (eligible.length === 0) {
      blocked.add(bestAssetClassId);
      warnings.push({ kind: "unreachable_gap", assetClassId: bestAssetClassId, remainingGap: bestGap });
      continue;
    }

    const account = eligible[0]!;
    const available = cash.get(account.id)!;
    const amount = Math.min(bestGap, available);
    const row = x.get(account.id)!;
    row.set(bestAssetClassId, (row.get(bestAssetClassId) ?? 0) + amount);
    gap.set(bestAssetClassId, bestGap - amount);
    cash.set(account.id, available - amount);
  }

  // Leftover pass: cash must be fully invested, so anything remaining goes
  // to the account's fallback asset class.
  for (const account of accounts) {
    const remaining = cash.get(account.id) ?? 0;
    if (remaining <= 0) continue;
    if (account.fallbackAssetClassId === undefined) {
      throw new Error(`Account "${account.id}" has leftover cash but no fallback asset class.`);
    }
    const row = x.get(account.id)!;
    row.set(account.fallbackAssetClassId, (row.get(account.fallbackAssetClassId) ?? 0) + remaining);
    warnings.push({
      kind: "leftover_cash",
      accountId: account.id,
      assetClassId: account.fallbackAssetClassId,
      amount: remaining,
    });
    cash.set(account.id, 0);
  }

  return { x, warnings };
}

/** Lower rank = more preferred account for this asset class's tax preference. */
function taxTypeRank(preference: TaxPreference, taxType: TaxType): number {
  if (preference === "neutral") return 0;
  const isTaxAdvantaged = taxType === "tax_deferred" || taxType === "tax_free";
  if (preference === "prefer_tax_advantaged") return isTaxAdvantaged ? 0 : 1;
  return taxType === "taxable" ? 0 : 1; // prefer_taxable
}
