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
  /**
   * What the fund is made of: assetClassId → weight in integer basis points,
   * summing to exactly TOTAL_BPS. Most funds map a single class to 10000; a
   * blended fund like VT splits its value across several (e.g.
   * { us_stocks: 6500, intl_stocks: 3500 }). Zero-weight entries are allowed
   * (the UI keeps them around mid-edit) and treated as absent. Trades move a
   * blend's components in lockstep — you can't buy just the US slice of VT.
   */
  assetClasses: Record<string, number>;
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
 * 100% expressed in basis points. Target weights must sum to exactly this,
 * and every bps-denominated quantity (weights, tolerance bands, deviations)
 * lives on the 0..TOTAL_BPS scale.
 */
export const TOTAL_BPS = 10000;

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
   * (default 0 = no minimum). Applies to selling only: contribution cash is
   * always fully invested, however small, because cash may not sit idle in
   * an account. A sell either clears this floor or doesn't happen.
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
  /** Post-trade value in integer cents, summed across all accounts. */
  value: number;
  /** Integer basis points of the total portfolio (post-trade). */
  weight: number;
  /** Value before any trades or contributions, integer cents. */
  currentValue: number;
  /** Target dollars at the post-contribution portfolio total, integer cents. */
  targetValue: number;
}

export interface PositionBreakdown {
  fundId: string;
  /** Held value before trades, integer cents. */
  currentValue: number;
  /** Buys minus sells of this fund, integer cents (0 = untouched). */
  tradeDelta: number;
  /** currentValue + tradeDelta. */
  finalValue: number;
}

/**
 * Per-account before/after view: what each account holds now, what the
 * trades change, and where it ends up. finalTotal is always currentTotal +
 * contribution, because money never leaves an account.
 */
export interface AccountBreakdown {
  accountId: string;
  /** Contribution cash earmarked to this account, integer cents. */
  contribution: number;
  currentTotal: number;
  finalTotal: number;
  /** Sorted by fundId; includes untouched holdings. */
  positions: PositionBreakdown[];
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
  /** Per-account before/after breakdown, sorted by accountId. */
  accounts: AccountBreakdown[];
  resultingAllocation: AllocationEntry[];
  deviationFromTarget: DeviationEntry[];
  warnings: string[];
}
