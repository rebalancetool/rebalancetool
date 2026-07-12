import type { TaxPreference, TaxType } from "./types.ts";

/**
 * The allocation seam.
 *
 * rebalance() reduces its input to a TransportationProblem in
 * (account × fund) space — ids and integer cents only; names, trade
 * construction, and warning wording stay in rebalance.ts. Each fund carries
 * its asset-class weights (basis points summing to TOTAL_BPS), so a fund's
 * dollars contribute to several class exposures at once; demands stay in
 * class space. allocate() decides the final placement x[a][f] under the one
 * hard constraint that money never leaves an account: each account's
 * post-trade total is fixed at Σ_f current[a][f] + cash[a] (a fixed-supply
 * transportation problem).
 *
 * This file implements the greedy waterfall described atop rebalance.ts. It
 * only supports single-class funds (a blended fund's buys and sells move
 * every component in lockstep, which the class-by-class waterfall cannot
 * express — rebalance() rejects that combination up front); internally it
 * solves in class space exactly as before, then distributes each class delta
 * onto that class's funds by preference rank. The LP alternative in
 * allocate.lp.ts handles blended funds natively.
 *
 * Determinism: results never depend on the order of the input arrays or map
 * entries; every choice ties off to a stable id comparison.
 */

export interface ProblemAccount {
  id: string;
  taxType: TaxType;
}

export interface ProblemAssetClass {
  id: string;
  taxPreference: TaxPreference;
}

export interface ProblemFund {
  id: string;
  /** assetClassId → basis points of this fund's value; positive entries only, summing to TOTAL_BPS. */
  weights: Map<string, number>;
}

export interface TransportationProblem {
  accounts: ProblemAccount[];
  assetClasses: ProblemAssetClass[];
  funds: ProblemFund[];
  /** Uninvested contribution cash per account id, integer cents. */
  cash: Map<string, number>;
  /** G[c]: target dollars per asset class id at the post-contribution total. */
  demands: Map<string, number>;
  /** H[a][f]: current dollars per account id per fund id. */
  current: Map<string, Map<string, number>>;
  /** Whether purchases of the fund can land in the account. */
  buyable: (accountId: string, fundId: string) => boolean;
  /**
   * Cap, in integer cents, on how much of the fund may be sold out of the
   * account across the whole run (0 = selling forbidden there). allocate
   * additionally never sells more than the account holds, and never sells an
   * asset class below its portfolio-level demand.
   */
  sellable: (accountId: string, fundId: string) => number;
  /**
   * Buy/sell preference of the fund within the account: lower = more
   * preferred (the position in availableFundIds). Must be finite; funds held
   * but not buyable should rank after every buyable fund. Buys for a class
   * go to its lowest-ranked fund, sells drain the highest-ranked first, and
   * leftover cash lands in the account's lowest-ranked buyable fund.
   */
  preferenceRank: (accountId: string, fundId: string) => number;
  /**
   * Tolerance band in integer cents. A class whose gap or excess is within
   * the band is treated as on-target: it is not bought toward, not used as a
   * sell donor, not fixed by selling, and not warned about.
   */
  toleranceCents: number;
  /** Minimum size, in integer cents, of a single sell-pass move (0 = none). */
  minTradeCents: number;
}

export type AllocationWarning =
  | { kind: "unreachable_gap"; assetClassId: string; remainingGap: number }
  | { kind: "leftover_cash"; accountId: string; fundId: string; amount: number };

export interface Allocation {
  /** x[a][f]: final dollars per account per fund; Σ_f x[a][f] = Σ_f current[a][f] + cash[a]. */
  x: Map<string, Map<string, number>>;
  /** Emission order: unreachable gaps (largest first), then leftovers in account-id order. */
  warnings: AllocationWarning[];
}

/** The sole asset class of a single-class fund; throws on blends (greedy can't place them). */
function soleClassOf(fund: ProblemFund): string {
  if (fund.weights.size !== 1) {
    throw new Error(
      `The greedy allocator only supports single-asset-class funds; fund "${fund.id}" spans ${fund.weights.size}.`,
    );
  }
  return fund.weights.keys().next().value!;
}

export function allocate(problem: TransportationProblem): Allocation {
  const accounts = [...problem.accounts].sort((a, b) => a.id.localeCompare(b.id));
  const assetClasses = [...problem.assetClasses].sort((a, b) => a.id.localeCompare(b.id));
  const funds = [...problem.funds].sort((a, b) => a.id.localeCompare(b.id));
  const taxPreferenceByClass = new Map(assetClasses.map((c) => [c.id, c.taxPreference]));
  const classByFund = new Map(funds.map((f) => [f.id, soleClassOf(f)]));

  // Class-space view of the fund-space inputs. Because every fund is
  // single-class this is exact, and the original waterfall runs unchanged.
  const heldFunds = new Map<string, Map<string, number>>();
  const x = new Map<string, Map<string, number>>();
  const cash = new Map<string, number>();
  for (const account of accounts) {
    const row = new Map<string, number>();
    heldFunds.set(account.id, new Map(problem.current.get(account.id) ?? []));
    for (const [fundId, value] of heldFunds.get(account.id)!) {
      const classId = classByFund.get(fundId)!;
      row.set(classId, (row.get(classId) ?? 0) + value);
    }
    x.set(account.id, row);
    cash.set(account.id, problem.cash.get(account.id) ?? 0);
  }

  /** Funds of the class buyable in the account, most-preferred first. */
  const buyableFundsFor = (accountId: string, assetClassId: string): ProblemFund[] =>
    funds
      .filter((f) => classByFund.get(f.id) === assetClassId && problem.buyable(accountId, f.id))
      .sort(
        (a, b) =>
          problem.preferenceRank(accountId, a.id) - problem.preferenceRank(accountId, b.id) ||
          a.id.localeCompare(b.id),
      );

  const buyableClass = (accountId: string, assetClassId: string): boolean =>
    buyableFundsFor(accountId, assetClassId).length > 0;

  const sellableClass = (accountId: string, assetClassId: string): number => {
    let cap = 0;
    const held = heldFunds.get(accountId)!;
    for (const fund of funds) {
      if (classByFund.get(fund.id) !== assetClassId) continue;
      cap += Math.max(0, Math.min(held.get(fund.id) ?? 0, problem.sellable(accountId, fund.id)));
    }
    return cap;
  };

  /** The account's most-preferred buyable fund — where leftover cash lands. */
  const fallbackFundFor = (accountId: string): ProblemFund | undefined =>
    funds
      .filter((f) => problem.buyable(accountId, f.id))
      .sort(
        (a, b) =>
          problem.preferenceRank(accountId, a.id) - problem.preferenceRank(accountId, b.id) ||
          a.id.localeCompare(b.id),
      )[0];

  // Remaining under-target gap per asset class, at the whole-portfolio
  // level. A gap within the tolerance band is treated as on-target (zeroed);
  // once a class is worth fixing at all, it is closed all the way to demand.
  const gap = new Map<string, number>();
  for (const assetClass of assetClasses) {
    const demand = problem.demands.get(assetClass.id) ?? 0;
    let held = 0;
    for (const account of accounts) held += x.get(account.id)!.get(assetClass.id) ?? 0;
    const raw = Math.max(0, demand - held);
    gap.set(assetClass.id, raw <= problem.toleranceCents ? 0 : raw);
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
      .filter((account) => (cash.get(account.id) ?? 0) > 0 && buyableClass(account.id, bestAssetClassId!))
      .sort((a, b) => {
        const rankA = taxTypeRank(preference, a.taxType);
        const rankB = taxTypeRank(preference, b.taxType);
        if (rankA !== rankB) return rankA - rankB;
        return a.id.localeCompare(b.id);
      });

    if (eligible.length === 0) {
      blocked.add(bestAssetClassId);
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

  // Sell pass: for each class still underweight, raise account-local cash by
  // selling an overweight class in an account that can buy the underweight
  // one, and redeploy it immediately (the sell and buy always share one
  // account — money never leaves an account). Every sell of a donor class d
  // is charged against a shrinking global excess budget C[d] - G[d], so no
  // class is ever sold below its own portfolio-level demand, and against the
  // caller's per-fund sellable caps. With all caps at 0 (buy-only mode) this
  // pass is a no-op.
  // Like gaps, an excess within the tolerance band is not worth trading:
  // such a class is never used as a sell donor.
  const excess = new Map<string, number>();
  for (const assetClass of assetClasses) {
    let held = 0;
    for (const account of accounts) held += x.get(account.id)!.get(assetClass.id) ?? 0;
    const raw = Math.max(0, held - (problem.demands.get(assetClass.id) ?? 0));
    excess.set(assetClass.id, raw <= problem.toleranceCents ? 0 : raw);
  }

  const sold = new Map<string, number>(); // "accountId assetClassId" -> cents sold so far
  const sellBlocked = new Set<string>();
  while (true) {
    let bestAssetClassId: string | null = null;
    let bestGap = 0;
    for (const [assetClassId, g] of gap) {
      // Unlike the buy pass (where spending cash toward target is free), a
      // sell is a new trade — never generate one for a gap inside the band.
      if (g <= problem.toleranceCents || sellBlocked.has(assetClassId)) continue;
      if (g > bestGap || (g === bestGap && (bestAssetClassId === null || assetClassId < bestAssetClassId))) {
        bestGap = g;
        bestAssetClassId = assetClassId;
      }
    }
    if (bestAssetClassId === null) break;

    // Best (account, donor class) pair: tax-advantaged account first (a sell
    // there has no tax consequence), then account id; within the account,
    // the donor with the largest global excess (id-order breaks ties, since
    // assetClasses iterate sorted and only a strictly larger excess wins).
    const rankedAccounts = accounts
      .filter((account) => buyableClass(account.id, bestAssetClassId!))
      .sort((a, b) => {
        const rankA = isTaxAdvantaged(a.taxType) ? 0 : 1;
        const rankB = isTaxAdvantaged(b.taxType) ? 0 : 1;
        if (rankA !== rankB) return rankA - rankB;
        return a.id.localeCompare(b.id);
      });

    let chosen: { accountId: string; donorId: string; cap: number } | null = null;
    for (const account of rankedAccounts) {
      const row = x.get(account.id)!;
      let bestDonor: { donorId: string; cap: number } | null = null;
      for (const donor of assetClasses) {
        if (donor.id === bestAssetClassId) continue;
        const donorExcess = excess.get(donor.id) ?? 0;
        if (donorExcess <= 0) continue;
        const soldKey = `${account.id} ${donor.id}`;
        const capRemaining = Math.min(
          row.get(donor.id) ?? 0,
          sellableClass(account.id, donor.id) - (sold.get(soldKey) ?? 0),
        );
        if (capRemaining <= 0) continue;
        if (Math.min(bestGap, donorExcess, capRemaining) < problem.minTradeCents) continue;
        if (bestDonor === null || donorExcess > (excess.get(bestDonor.donorId) ?? 0)) {
          bestDonor = { donorId: donor.id, cap: capRemaining };
        }
      }
      if (bestDonor !== null) {
        chosen = { accountId: account.id, donorId: bestDonor.donorId, cap: bestDonor.cap };
        break;
      }
    }

    if (chosen === null) {
      sellBlocked.add(bestAssetClassId);
      continue;
    }

    const amount = Math.min(bestGap, excess.get(chosen.donorId) ?? 0, chosen.cap);
    const row = x.get(chosen.accountId)!;
    row.set(chosen.donorId, (row.get(chosen.donorId) ?? 0) - amount);
    row.set(bestAssetClassId, (row.get(bestAssetClassId) ?? 0) + amount);
    gap.set(bestAssetClassId, bestGap - amount);
    excess.set(chosen.donorId, (excess.get(chosen.donorId) ?? 0) - amount);
    const soldKey = `${chosen.accountId} ${chosen.donorId}`;
    sold.set(soldKey, (sold.get(soldKey) ?? 0) + amount);
  }

  // Gaps that survived both passes and exceed the band, largest first.
  const unreachable = [...gap.entries()]
    .filter(([, g]) => g > problem.toleranceCents)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [assetClassId, remainingGap] of unreachable) {
    warnings.push({ kind: "unreachable_gap", assetClassId, remainingGap });
  }

  // Leftover pass: cash must be fully invested, so anything remaining goes
  // to the account's most-preferred buyable fund.
  for (const account of accounts) {
    const remaining = cash.get(account.id) ?? 0;
    if (remaining <= 0) continue;
    const fallback = fallbackFundFor(account.id);
    if (fallback === undefined) {
      throw new Error(`Account "${account.id}" has leftover cash but no buyable fund to absorb it.`);
    }
    const classId = classByFund.get(fallback.id)!;
    const row = x.get(account.id)!;
    row.set(classId, (row.get(classId) ?? 0) + remaining);
    warnings.push({ kind: "leftover_cash", accountId: account.id, fundId: fallback.id, amount: remaining });
    cash.set(account.id, 0);
  }

  // Distribute each account's class-space result onto funds: buys go to the
  // class's most-preferred buyable fund, sells drain the least-preferred
  // holdings first (funds ranked past every buyable — held but no longer
  // buyable — go first of all). This is exact: single-class funds mean each
  // class delta maps onto that class's funds alone.
  const fundX = new Map<string, Map<string, number>>();
  for (const account of accounts) {
    const held = heldFunds.get(account.id)!;
    const row = new Map<string, number>();
    for (const [fundId, value] of held) row.set(fundId, value);

    for (const assetClass of assetClasses) {
      let currentClassTotal = 0;
      for (const [fundId, value] of held) {
        if (classByFund.get(fundId) === assetClass.id) currentClassTotal += value;
      }
      const delta = (x.get(account.id)!.get(assetClass.id) ?? 0) - currentClassTotal;
      if (delta > 0) {
        const fund = buyableFundsFor(account.id, assetClass.id)[0]!;
        row.set(fund.id, (row.get(fund.id) ?? 0) + delta);
      } else if (delta < 0) {
        const donors = funds
          .filter((f) => classByFund.get(f.id) === assetClass.id && (held.get(f.id) ?? 0) > 0)
          .sort(
            (a, b) =>
              problem.preferenceRank(account.id, b.id) - problem.preferenceRank(account.id, a.id) ||
              a.id.localeCompare(b.id),
          );
        let remainingToSell = -delta;
        for (const fund of donors) {
          if (remainingToSell <= 0) break;
          const cap = Math.max(0, Math.min(held.get(fund.id) ?? 0, problem.sellable(account.id, fund.id)));
          const amount = Math.min(cap, remainingToSell);
          row.set(fund.id, (row.get(fund.id) ?? 0) - amount);
          remainingToSell -= amount;
        }
        if (remainingToSell > 0) {
          throw new Error(
            `Internal error: cannot place a ${remainingToSell}-cent sell of "${assetClass.id}" in account "${account.id}".`,
          );
        }
      }
    }
    fundX.set(account.id, row);
  }

  return { x: fundX, warnings };
}

/** Lower rank = more preferred account for this asset class's tax preference. */
export function taxTypeRank(preference: TaxPreference, taxType: TaxType): number {
  if (preference === "neutral") return 0;
  if (preference === "prefer_tax_advantaged") return isTaxAdvantaged(taxType) ? 0 : 1;
  return taxType === "taxable" ? 0 : 1; // prefer_taxable
}

export function isTaxAdvantaged(taxType: TaxType): boolean {
  return taxType === "tax_deferred" || taxType === "tax_free";
}
