/**
 * Domain model for the rebalancer. All money is integer cents (never a
 * float). All weights are integer basis points, 0-10000 (never a fraction).
 */

export type TaxType = "taxable" | "tax_deferred" | "tax_free";

/**
 * Where an asset class is more tax-efficient to hold, used to rank eligible
 * accounts when more than one could receive a given asset class (e.g. bonds
 * are usually better sheltered in a tax_deferred/tax_free account; total-market
 * stock funds are usually fine, or even preferable, in a taxable account).
 * Defaults to "neutral" when omitted.
 */
export type TaxPreference = "prefer_taxable" | "prefer_tax_advantaged" | "neutral";

export interface AssetClass {
  id: string;
  name: string;
  taxPreference?: TaxPreference;
}

export interface Fund {
  id: string;
  ticker?: string;
  name: string;
  assetClassId: string;
}

export interface Account {
  id: string;
  name: string;
  taxType: TaxType;
  /**
   * Fund ids that can be bought in this account, ordered most-preferred
   * first. When several available funds belong to the same asset class, the
   * earliest one is bought; the very first entry is also the fallback for
   * investing leftover contribution cash. (A fund can still be *held* without
   * appearing here — holdings may reference funds that are no longer buyable.)
   */
  availableFundIds: string[];
}

export interface Holding {
  accountId: string;
  fundId: string;
  /** Current market value, in integer cents. */
  value: number;
}

export interface Target {
  assetClassId: string;
  /** Target weight in integer basis points. All targets together must sum to 10000. */
  weight: number;
}

/**
 * Cash earmarked for a specific account (e.g. a payroll 401k contribution,
 * or a deposit into a taxable brokerage account). Contributions cannot move
 * between accounts — money contributed to one account can only buy funds
 * available in that same account.
 */
export interface Contribution {
  accountId: string;
  /** Cash amount to invest, in integer cents. */
  amount: number;
}

export interface Trade {
  accountId: string;
  fundId: string;
  action: "buy" | "sell";
  /** Integer cents, always positive (direction is carried by `action`). */
  amount: number;
  reason: string;
}

export interface Portfolio {
  accounts: Account[];
  funds: Fund[];
  assetClasses: AssetClass[];
  holdings: Holding[];
}

/**
 * Default tolerance band: an asset class within ±0.5% of its target weight
 * is treated as on-target, so ordinary drift is absorbed by contributions
 * instead of triggering trades. Pass toleranceBps: 0 for exact rebalancing.
 */
export const DEFAULT_TOLERANCE_BPS = 50;

export interface RebalanceOptions {
  contributions: Contribution[];
  /**
   * Allow selling overweight positions to fund underweight ones. Cash raised
   * by a sell never leaves its account — selling in account A can only fund
   * buys in account A. A class is never sold below its portfolio-level
   * target. Default false (buy-only).
   */
  allowSelling?: boolean;
  /**
   * Allow sells inside taxable accounts, where they can realize capital
   * gains. Only meaningful with allowSelling. Default false: only
   * tax-advantaged accounts are rebalanced by selling, and taxable positions
   * are never trimmed.
   */
  sellInTaxableAccounts?: boolean;
  /**
   * Tolerance band in basis points (default DEFAULT_TOLERANCE_BPS = 50). An
   * asset class whose deviation from target is within the band is treated as
   * on-target: it neither attracts rebalancing trades nor triggers an
   * unreachable-gap warning, and positions within the band are never sold
   * down. 0 = rebalance exactly. This is the governor that keeps the solver
   * from churning the whole portfolio to fix trivial drift.
   */
  toleranceBps?: number;
  /**
   * Minimum size, in integer cents, of a sell-funded rebalancing move
   * (default 0 = no minimum). Applies to the sell pass only: contribution
   * cash is always fully invested, however small, because cash may not sit
   * idle in an account.
   */
  minTradeCents?: number;
}

/**
 * The complete, canonical input document: everything rebalance() needs, in
 * one JSON-serializable shape. The CLI reads exactly this from disk, and a
 * future UI can save/load the same document. Parse untrusted JSON with
 * validateScenario() to get one of these.
 */
export interface Scenario {
  portfolio: Portfolio;
  targets: Target[];
  contributions: Contribution[];
  options?: Omit<RebalanceOptions, "contributions">;
}

export interface AllocationEntry {
  assetClassId: string;
  /** Integer cents, summed across all accounts. */
  value: number;
  /** Integer basis points of the total portfolio (post-trade). */
  weight: number;
}

export interface DeviationEntry {
  assetClassId: string;
  targetWeight: number;
  actualWeight: number;
  /** actualWeight - targetWeight, in basis points. Positive = overweight. */
  deviationBps: number;
}

export interface RebalanceResult {
  trades: Trade[];
  resultingAllocation: AllocationEntry[];
  deviationFromTarget: DeviationEntry[];
  warnings: string[];
}
