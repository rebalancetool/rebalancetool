import { describe, expect, it } from "vitest";
import { rebalance } from "./rebalance.ts";
import { validateScenario } from "./scenario.ts";
import type { Portfolio, Scenario, Target } from "./types.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };
import sellRequiredFixtureRaw from "../fixtures/sell-required.json" with { type: "json" };

// Running the fixtures through validateScenario doubles as a smoke test
// that the checked-in documents match the canonical Scenario shape.
const exampleFixture: Scenario = validateScenario(exampleFixtureRaw);
const sellRequiredFixture: Scenario = validateScenario(sellRequiredFixtureRaw);

function loadFixture(fixture: Scenario) {
  const { portfolio, targets, contributions } = fixture;
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

  it("never touches the already-overweight fund and warns only about actionable gaps", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });

    expect(result.trades.some((t) => t.fundId === "vti")).toBe(false);
    // Four asset classes end below target, but only intl_bonds is
    // *structurally* stuck: the sole account offering BNDX (spouse IRA) got
    // no contribution. The others just ran out of cash, which the allocation
    // data already shows — no warning for those.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("International Bonds");
    expect(result.warnings[0]).toContain("Spouse Traditional IRA");
    expect(result.warnings[0]).toContain("received no contribution");
  });

  it("reports a per-account before/after breakdown that matches the trades", () => {
    const { portfolio, targets, contributions } = loadExample();
    const result = rebalance(portfolio, targets, { contributions });

    expect(result.accounts.map((a) => a.accountId)).toEqual(["hsa", "k401", "roth_ira", "spouse_ira", "taxable"]);

    const k401 = result.accounts.find((a) => a.accountId === "k401")!;
    expect(k401).toEqual({
      accountId: "k401",
      contribution: 15000,
      currentTotal: 2000000,
      finalTotal: 2015000,
      positions: [
        { fundId: "bnd", currentValue: 500000, tradeDelta: 15000, finalValue: 515000 },
        { fundId: "vti", currentValue: 1500000, tradeDelta: 0, finalValue: 1500000 },
      ],
    });

    // An account with no contribution and no trades still appears, unchanged.
    const spouseIra = result.accounts.find((a) => a.accountId === "spouse_ira")!;
    expect(spouseIra.contribution).toBe(0);
    expect(spouseIra.finalTotal).toBe(spouseIra.currentTotal);
    expect(spouseIra.positions).toEqual([{ fundId: "bnd", currentValue: 500000, tradeDelta: 0, finalValue: 500000 }]);

    // Class-level current/target dollars round-trip too.
    const intlStocks = result.resultingAllocation.find((a) => a.assetClassId === "intl_stocks")!;
    expect(intlStocks.currentValue).toBe(800000);
    expect(intlStocks.targetValue).toBe(1212000);
    expect(intlStocks.value).toBe(845000);
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

describe("rebalance - tolerance band and minTradeCents", () => {
  /** One IRA at 50/50 target, holdings drifted to the given stock/bond split. */
  function driftedPortfolio(stockValue: number, bondValue: number): { portfolio: Portfolio; targets: Target[] } {
    const portfolio: Portfolio = {
      assetClasses: [
        { id: "stocks", name: "Stocks" },
        { id: "bonds", name: "Bonds" },
      ],
      funds: [
        { id: "vti", name: "VTI", assetClassId: "stocks" },
        { id: "bnd", name: "BND", assetClassId: "bonds" },
      ],
      accounts: [{ id: "ira", name: "IRA", taxType: "tax_deferred", availableFundIds: ["vti", "bnd"] }],
      holdings: [
        { accountId: "ira", fundId: "vti", value: stockValue },
        { accountId: "ira", fundId: "bnd", value: bondValue },
      ],
    };
    const targets: Target[] = [
      { assetClassId: "stocks", weight: 5000 },
      { assetClassId: "bonds", weight: 5000 },
    ];
    return { portfolio, targets };
  }

  it("ignores drift within the default 0.5% band instead of churning", () => {
    // 20 cents of drift on a $100 portfolio = 20 bps, inside the 50 bps band.
    const { portfolio, targets } = driftedPortfolio(5020, 4980);
    const result = rebalance(portfolio, targets, { contributions: [], allowSelling: true });

    expect(result.trades).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("toleranceBps: 0 rebalances the same drift exactly", () => {
    const { portfolio, targets } = driftedPortfolio(5020, 4980);
    const result = rebalance(portfolio, targets, { contributions: [], allowSelling: true, toleranceBps: 0 });

    expect(
      result.trades.map(({ accountId, fundId, action, amount }) => ({ accountId, fundId, action, amount })),
    ).toEqual([
      { accountId: "ira", fundId: "vti", action: "sell", amount: 20 },
      { accountId: "ira", fundId: "bnd", action: "buy", amount: 20 },
    ]);
  });

  it("minTradeCents suppresses sell moves below the floor and warns about the remaining gap", () => {
    const { portfolio, targets } = driftedPortfolio(5300, 4700); // 300 bps drift, outside the band
    const blocked = rebalance(portfolio, targets, { contributions: [], allowSelling: true, minTradeCents: 500 });
    expect(blocked.trades).toEqual([]);
    expect(blocked.warnings).toHaveLength(1);

    const allowed = rebalance(portfolio, targets, { contributions: [], allowSelling: true, minTradeCents: 100 });
    expect(allowed.trades).toHaveLength(2);
    expect(allowed.warnings).toEqual([]);
  });

  it("buy-only: contribution cash skips sub-band gaps and goes to the fallback fund", () => {
    const { portfolio, targets } = driftedPortfolio(5001, 4999);
    const result = rebalance(portfolio, targets, { contributions: [{ accountId: "ira", amount: 10 }] });

    // The 6-cent bond gap is inside the band, so the 10 cents of cash is
    // invested in the account's most-preferred fund instead.
    expect(
      result.trades.map(({ accountId, fundId, action, amount }) => ({ accountId, fundId, action, amount })),
    ).toEqual([{ accountId: "ira", fundId: "vti", action: "buy", amount: 10 }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("left after closing every reachable gap");
  });

  it("rejects a non-integer or out-of-range toleranceBps and negative minTradeCents", () => {
    const { portfolio, targets } = driftedPortfolio(5000, 5000);
    expect(() => rebalance(portfolio, targets, { contributions: [], toleranceBps: 10001 })).toThrow(/toleranceBps/);
    expect(() => rebalance(portfolio, targets, { contributions: [], toleranceBps: 1.5 })).toThrow(/toleranceBps/);
    expect(() => rebalance(portfolio, targets, { contributions: [], minTradeCents: -1 })).toThrow(/minTradeCents/);
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

  it("warns when a targeted asset class is offered by no account at all", () => {
    const portfolio: Portfolio = {
      assetClasses: [
        { id: "stocks", name: "Stocks" },
        { id: "gold", name: "Gold" },
      ],
      funds: [
        { id: "vti", name: "VTI", assetClassId: "stocks" },
        { id: "gld", name: "GLD", assetClassId: "gold" },
      ],
      accounts: [{ id: "acct", name: "Account", taxType: "taxable", availableFundIds: ["vti"] }],
      holdings: [{ accountId: "acct", fundId: "vti", value: 10000 }],
    };
    const targets: Target[] = [
      { assetClassId: "stocks", weight: 9000 },
      { assetClassId: "gold", weight: 1000 },
    ];
    const result = rebalance(portfolio, targets, { contributions: [{ accountId: "acct", amount: 1000 }] });

    expect(result.warnings.some((w) => w.includes("no account offers a fund for it") && w.includes("Gold"))).toBe(
      true,
    );
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
