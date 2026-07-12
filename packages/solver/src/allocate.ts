import type { TaxPreference, TaxType } from "./types.ts";

/**
 * The allocation seam.
 *
 * rebalance() reduces its input to a TransportationProblem in
 * (account × fund) space — ids and integer cents only; names, trade
 * construction, and warning wording stay in rebalance.ts. Each fund carries
 * its asset-class weights (basis points summing to TOTAL_BPS), so a fund's
 * dollars contribute to several class exposures at once; demands stay in
 * class space. The allocator decides the final placement x[a][f] under the
 * one hard constraint that money never leaves an account: each account's
 * post-trade total is fixed at Σ_f current[a][f] + cash[a] (a fixed-supply
 * transportation problem).
 *
 * The implementation lives in allocate.lp.ts (a linear program). This file
 * defines the problem/solution contract so the two stay separable — a
 * replacement engine would implement the same signature. (A greedy
 * waterfall used to live here; it was removed once the LP covered
 * everything it did and more — see the git history if you need it back.)
 * Do not hand-roll a min-cost-flow solver.
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
   * account across the whole run (0 = selling forbidden there). The
   * allocator additionally never sells more than the account holds, and
   * never sells an asset class below its portfolio-level demand.
   */
  sellable: (accountId: string, fundId: string) => number;
  /**
   * Buy/sell preference of the fund within the account: lower = more
   * preferred (the position in availableFundIds). Must be finite; funds held
   * but not buyable should rank after every buyable fund. Buys for a class
   * go to its lowest-ranked fund, sells drain the highest-ranked first, and
   * surplus cash lands in the account's lowest-ranked buyable fund.
   */
  preferenceRank: (accountId: string, fundId: string) => number;
  /**
   * Tolerance band in integer cents. A class whose gap or excess is within
   * the band is treated as on-target: it is not bought toward, not used as a
   * sell donor, not fixed by selling, and not warned about.
   */
  toleranceCents: number;
  /** Minimum size, in integer cents, of a single sell-funded move (0 = none). */
  minTradeCents: number;
}

export type AllocationWarning = { kind: "unreachable_gap"; assetClassId: string; remainingGap: number };

export interface Allocation {
  /** x[a][f]: final dollars per account per fund; Σ_f x[a][f] = Σ_f current[a][f] + cash[a]. */
  x: Map<string, Map<string, number>>;
  /** Unreachable gaps beyond the band, largest first. */
  warnings: AllocationWarning[];
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
