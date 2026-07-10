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
