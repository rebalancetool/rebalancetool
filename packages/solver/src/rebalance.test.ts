import { describe, expect, it } from "vitest";
import { rebalance } from "./rebalance.ts";
import type { Account, AssetClass, Contribution, Fund, Holding, Portfolio, Target } from "./types.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };
import sellRequiredFixtureRaw from "../fixtures/sell-required.json" with { type: "json" };

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
const sellRequiredFixture = sellRequiredFixtureRaw as unknown as ExampleFixture;

function loadFixture(fixture: ExampleFixture) {
  const { assetClasses, funds, accounts, holdings, targets, contributions } = fixture;
  const portfolio: Portfolio = { assetClasses, funds, accounts, holdings };
  return { portfolio, targets, contributions };
}

function loadExample() {
  return loadFixture(exampleFixture);
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

describe("rebalance - selling (golden fixture)", () => {
  // Hand-traced against fixtures/sell-required.json: $200,000 total, no new
  // cash. Target is 60/40 stocks/bonds = $120,000 / $80,000; current is
  // $160,000 / $40,000. The only route to target is selling $40,000 of the
  // IRA's VTI and rotating it into BND — the taxable account never trades.
  it("rotates the IRA into bonds and reaches target exactly", () => {
    const { portfolio, targets, contributions } = loadFixture(sellRequiredFixture);
    const result = rebalance(portfolio, targets, { contributions, allowSelling: true });

    expect(
      result.trades.map(({ accountId, fundId, action, amount }) => ({ accountId, fundId, action, amount })),
    ).toEqual([
      { accountId: "ira", fundId: "vti", action: "sell", amount: 4000000 },
      { accountId: "ira", fundId: "bnd", action: "buy", amount: 4000000 },
    ]);
    for (const trade of result.trades) {
      expect(trade.reason.length).toBeGreaterThan(0);
    }
    expect(result.warnings).toEqual([]);
    for (const deviation of result.deviationFromTarget) {
      expect(deviation.deviationBps).toBe(0);
    }
  });

  it("without allowSelling the same portfolio is stuck and warns", () => {
    const { portfolio, targets, contributions } = loadFixture(sellRequiredFixture);
    const result = rebalance(portfolio, targets, { contributions });

    expect(result.trades).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("US Bonds");
  });

  it("conserves each account's total: buys minus sells equal the (zero) contribution", () => {
    const { portfolio, targets, contributions } = loadFixture(sellRequiredFixture);
    const result = rebalance(portfolio, targets, { contributions, allowSelling: true });

    for (const account of portfolio.accounts) {
      const net = result.trades
        .filter((t) => t.accountId === account.id)
        .reduce((sum, t) => sum + (t.action === "buy" ? t.amount : -t.amount), 0);
      expect(net).toBe(0);
    }
  });
});

describe("rebalance - selling guards", () => {
  // Overweight stocks live only in the taxable account: without
  // sellInTaxableAccounts nothing may be sold, with it the taxable account
  // rotates into bonds itself.
  function taxableOnlyExcess(): { portfolio: Portfolio; targets: Target[] } {
    const portfolio: Portfolio = {
      assetClasses: [
        { id: "us_stocks", name: "US Stocks", taxPreference: "prefer_taxable" },
        { id: "us_bonds", name: "US Bonds", taxPreference: "prefer_tax_advantaged" },
      ],
      funds: [
        { id: "vti", name: "VTI", assetClassId: "us_stocks" },
        { id: "bnd", name: "BND", assetClassId: "us_bonds" },
      ],
      accounts: [
        { id: "taxable", name: "Taxable", taxType: "taxable", availableFundIds: ["vti", "bnd"] },
        { id: "ira", name: "IRA", taxType: "tax_deferred", availableFundIds: ["bnd"] },
      ],
      holdings: [
        { accountId: "taxable", fundId: "vti", value: 16000000 },
        { accountId: "ira", fundId: "bnd", value: 4000000 },
      ],
    };
    const targets: Target[] = [
      { assetClassId: "us_stocks", weight: 6000 },
      { assetClassId: "us_bonds", weight: 4000 },
    ];
    return { portfolio, targets };
  }

  it("never trims taxable positions unless sellInTaxableAccounts is set", () => {
    const { portfolio, targets } = taxableOnlyExcess();
    const result = rebalance(portfolio, targets, { contributions: [], allowSelling: true });

    expect(result.trades).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("selling in taxable accounts is disabled");
  });

  it("with sellInTaxableAccounts the taxable account rotates into bonds", () => {
    const { portfolio, targets } = taxableOnlyExcess();
    const result = rebalance(portfolio, targets, {
      contributions: [],
      allowSelling: true,
      sellInTaxableAccounts: true,
    });

    expect(
      result.trades.map(({ accountId, fundId, action, amount }) => ({ accountId, fundId, action, amount })),
    ).toEqual([
      { accountId: "taxable", fundId: "vti", action: "sell", amount: 4000000 },
      { accountId: "taxable", fundId: "bnd", action: "buy", amount: 4000000 },
    ]);
    for (const deviation of result.deviationFromTarget) {
      expect(deviation.deviationBps).toBe(0);
    }
  });

  it("sells the least-preferred fund of an overweight class first", () => {
    const portfolio: Portfolio = {
      assetClasses: [
        { id: "stocks", name: "Stocks" },
        { id: "bonds", name: "Bonds" },
      ],
      funds: [
        { id: "vti", name: "VTI", assetClassId: "stocks" },
        { id: "itot", name: "ITOT", assetClassId: "stocks" },
        { id: "bnd", name: "BND", assetClassId: "bonds" },
      ],
      accounts: [
        // vti is preferred over itot, so itot must be sold first.
        { id: "ira", name: "IRA", taxType: "tax_deferred", availableFundIds: ["bnd", "vti", "itot"] },
      ],
      holdings: [
        { accountId: "ira", fundId: "vti", value: 3000 },
        { accountId: "ira", fundId: "itot", value: 2000 },
      ],
    };
    const targets: Target[] = [
      { assetClassId: "stocks", weight: 2000 },
      { assetClassId: "bonds", weight: 8000 },
    ];
    const result = rebalance(portfolio, targets, { contributions: [], allowSelling: true });

    expect(
      result.trades.map(({ accountId, fundId, action, amount }) => ({ accountId, fundId, action, amount })),
    ).toEqual([
      { accountId: "ira", fundId: "itot", action: "sell", amount: 2000 },
      { accountId: "ira", fundId: "vti", action: "sell", amount: 2000 },
      { accountId: "ira", fundId: "bnd", action: "buy", amount: 4000 },
    ]);
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

  it("buys the earliest availableFundIds entry when several funds share the asset class", () => {
    const portfolio: Portfolio = {
      assetClasses: [{ id: "stocks", name: "Stocks" }],
      funds: [
        { id: "fund_a", name: "Fund A", assetClassId: "stocks" },
        { id: "fund_b", name: "Fund B", assetClassId: "stocks" },
      ],
      accounts: [
        // fund_b listed first: availableFundIds order, not id order, must win.
        { id: "acct", name: "Account", taxType: "taxable", availableFundIds: ["fund_b", "fund_a"] },
      ],
      holdings: [],
    };
    const targets: Target[] = [{ assetClassId: "stocks", weight: 10000 }];
    const result = rebalance(portfolio, targets, { contributions: [{ accountId: "acct", amount: 10000 }] });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.fundId).toBe("fund_b");
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
