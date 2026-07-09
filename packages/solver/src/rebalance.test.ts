import { describe, expect, it } from "vitest";
import { rebalance } from "./rebalance.ts";
import type { Account, AssetClass, Contribution, Fund, Holding, Portfolio, Target } from "./types.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };

interface ExampleFixture {
  assetClasses: AssetClass[];
  funds: Fund[];
  accounts: Account[];
  holdings: Holding[];
  targets: Target[];
  contributions: Contribution[];
}

// The JSON import widens string-literal fields (e.g. taxType) to `string`;
// this fixture is trusted, hand-authored test data, so a single cast at the
// boundary is fine.
const exampleFixture = exampleFixtureRaw as unknown as ExampleFixture;

function loadExample() {
  const { assetClasses, funds, accounts, holdings, targets, contributions } = exampleFixture;
  const portfolio: Portfolio = { assetClasses, funds, accounts, holdings };
  return { portfolio, targets, contributions };
}

describe("rebalance - golden fixture", () => {
  // Hand-traced against fixtures/example.json: total portfolio $60,000 + $600
  // contribution = $60,600 new total. Target dollars per asset class divide
  // evenly at that total, so gaps are exact. us_stocks is already overweight
  // (gap 0). intl_bonds only exists in spouse_ira's fund menu, which gets no
  // contribution, so its $6,060 gap is unreachable this run. us_small_cap_value
  // is only offered by roth_ira (no contribution) and k401 (no AVUV), so it's
  // unreachable too. Only intl_stocks (via taxable, then hsa) and us_bonds
  // (via k401) end up funded.
  it("produces the expected trades for the example household", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });

    expect(
      result.trades.map(({ accountId, fundId, action, amount }) => ({ accountId, fundId, action, amount })),
    ).toEqual([
      { accountId: "hsa", fundId: "vxus", action: "buy", amount: 5000 },
      { accountId: "k401", fundId: "bnd", action: "buy", amount: 15000 },
      { accountId: "taxable", fundId: "vxus", action: "buy", amount: 40000 },
    ]);
    for (const trade of result.trades) {
      expect(trade.reason.length).toBeGreaterThan(0);
    }
  });

  it("never touches the already-overweight fund and flags every unreachable gap", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });

    expect(result.trades.some((t) => t.fundId === "vti")).toBe(false);
    // intl_bonds and us_small_cap_value are never reachable (no funded account
    // offers those funds); intl_stocks and us_bonds each get partially closed
    // before the accounts that could fund them run out of cash.
    expect(result.warnings).toHaveLength(4);
    const allWarnings = result.warnings.join(" ");
    expect(allWarnings).toContain("International Bonds");
    expect(allWarnings).toContain("International Stocks");
    expect(allWarnings).toContain("US Small-Cap Value");
    expect(allWarnings).toContain("US Bonds");
  });

  it("fully invests the contribution and conserves total portfolio value", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });

    const totalContribution = contributions.reduce((sum, c) => sum + c.amount, 0);
    const totalTraded = result.trades.reduce((sum, t) => sum + t.amount, 0);
    expect(totalTraded).toBe(totalContribution);

    const totalResulting = result.resultingAllocation.reduce((sum, a) => sum + a.value, 0);
    const totalHoldings = portfolio.holdings.reduce((sum, h) => sum + h.value, 0);
    expect(totalResulting).toBe(totalHoldings + totalContribution);
  });
});

describe("rebalance - core invariants", () => {
  it("returns zero trades when every contribution is zero", () => {
    const { portfolio, targets } = loadExample();
    const result = rebalance(portfolio, targets, {
      contributions: portfolio.accounts.map((a) => ({ accountId: a.id, amount: 0 })),
    });
    expect(result.trades).toEqual([]);
  });

  it("returns zero trades with no contributions at all", () => {
    const { portfolio, targets } = loadExample();
    const result = rebalance(portfolio, targets, { contributions: [] });
    expect(result.trades).toEqual([]);
  });

  it("sum of trade amounts equals the total contribution exactly", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });
    const totalContribution = contributions.reduce((sum, c) => sum + c.amount, 0);
    const totalTraded = result.trades.reduce((sum, t) => sum + t.amount, 0);
    expect(totalTraded).toBe(totalContribution);
  });

  it("never names a fund outside its account's availableFundIds", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });
    const accountsById = new Map(portfolio.accounts.map((a) => [a.id, a]));
    for (const trade of result.trades) {
      const account = accountsById.get(trade.accountId)!;
      expect(account.availableFundIds).toContain(trade.fundId);
    }
  });

  it("rejects targets that do not sum to 10000 bps", () => {
    const { portfolio } = loadExample();
    const badTargets: Target[] = [{ assetClassId: "us_stocks", weight: 9000 }];
    expect(() => rebalance(portfolio, badTargets, { contributions: [] })).toThrow(/10000/);
  });

  it("rejects a contribution to an unknown account", () => {
    const { portfolio, targets } = loadExample();
    expect(() =>
      rebalance(portfolio, targets, { contributions: [{ accountId: "does_not_exist", amount: 100 }] }),
    ).toThrow(/unknown account/);
  });
});
