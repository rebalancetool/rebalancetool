import { rebalance } from "@rebalancer/solver";
import type { Scenario } from "@rebalancer/solver";
import { expect, test } from "vitest";
import {
  addAccount,
  addAssetClass,
  addFund,
  addFundClass,
  emptyScenario,
  fundWeightTotal,
  removeAccount,
  removeAssetClass,
  removeFund,
  removeFundClass,
  reorderFundPreference,
  replaceFundClass,
  setFundAvailability,
  setFundClassWeight,
  setFundSoleClass,
  targetWeightTotal,
  updateAssetClass,
  updateFund,
  withContribution,
  withHolding,
  withOptions,
  withTargetWeight,
} from "./scenario-edit.ts";

const base: Scenario = {
  portfolio: {
    assetClasses: [
      { id: "stocks", name: "Stocks" },
      { id: "bonds", name: "Bonds" },
    ],
    funds: [{ id: "vti", name: "VTI", assetClasses: { "stocks": 10000 } }],
    accounts: [{ id: "ira", name: "IRA", taxType: "tax_deferred", availableFundIds: ["vti"] }],
    holdings: [{ accountId: "ira", fundId: "vti", value: 100000 }],
  },
  targets: [{ assetClassId: "stocks", weight: 10000 }],
  contributions: [{ accountId: "ira", amount: 5000 }],
};

test("withTargetWeight updates an existing target and never mutates", () => {
  const updated = withTargetWeight(base, "stocks", 6000);
  expect(updated.targets).toEqual([{ assetClassId: "stocks", weight: 6000 }]);
  expect(base.targets[0]!.weight).toBe(10000);
});

test("withTargetWeight adds a missing target entry", () => {
  const updated = withTargetWeight(base, "bonds", 4000);
  expect(updated.targets).toContainEqual({ assetClassId: "bonds", weight: 4000 });
  expect(targetWeightTotal(updated)).toBe(14000);
});

test("withContribution replaces an account's entry and removes it at zero", () => {
  expect(withContribution(base, "ira", 25000).contributions).toEqual([{ accountId: "ira", amount: 25000 }]);
  expect(withContribution(base, "ira", 0).contributions).toEqual([]);
});

test("a portfolio built from scratch with the updaters is solvable", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "US Stocks");
  s = addFund(s, "VTI", "us-stocks");
  s = addAccount(s, "My IRA", "tax_deferred");
  s = setFundAvailability(s, "my-ira", "vti", true);
  s = withHolding(s, "my-ira", "vti", 90000);
  s = withTargetWeight(s, "us-stocks", 10000);
  s = withContribution(s, "my-ira", 10000);

  const result = rebalance(s.portfolio, s.targets, { ...s.options, contributions: s.contributions });
  expect(result.trades).toEqual([
    { accountId: "my-ira", fundId: "vti", action: "buy", amount: 10000, reason: expect.any(String) },
  ]);
});

test("ids are slugs uniquified against collisions", () => {
  let s = addAssetClass(emptyScenario(), "US Stocks!");
  s = addAssetClass(s, "US Stocks");
  expect(s.portfolio.assetClasses.map((c) => c.id)).toEqual(["us-stocks", "us-stocks-2"]);
});

test("removeAssetClass cascades to funds, holdings, menus, and targets", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "Stocks");
  s = addAssetClass(s, "Bonds");
  s = addFund(s, "VTI", "stocks");
  s = addFund(s, "BND", "bonds");
  s = addAccount(s, "IRA", "tax_deferred");
  s = setFundAvailability(s, "ira", "vti", true);
  s = setFundAvailability(s, "ira", "bnd", true);
  s = withHolding(s, "ira", "bnd", 5000);
  s = withTargetWeight(s, "stocks", 6000);
  s = withTargetWeight(s, "bonds", 4000);

  const pruned = removeAssetClass(s, "bonds");
  expect(pruned.portfolio.funds.map((f) => f.id)).toEqual(["vti"]);
  expect(pruned.portfolio.holdings).toEqual([]);
  expect(pruned.portfolio.accounts[0]!.availableFundIds).toEqual(["vti"]);
  expect(pruned.targets).toEqual([{ assetClassId: "stocks", weight: 6000 }]);
});

test("removeFund and removeAccount cascade their references", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "Stocks");
  s = addFund(s, "VTI", "stocks");
  s = addAccount(s, "IRA", "tax_deferred");
  s = setFundAvailability(s, "ira", "vti", true);
  s = withHolding(s, "ira", "vti", 5000);
  s = withContribution(s, "ira", 1000);

  const noFund = removeFund(s, "vti");
  expect(noFund.portfolio.holdings).toEqual([]);
  expect(noFund.portfolio.accounts[0]!.availableFundIds).toEqual([]);

  const noAccount = removeAccount(s, "ira");
  expect(noAccount.portfolio.holdings).toEqual([]);
  expect(noAccount.contributions).toEqual([]);
});

test("setFundAvailability appends least-preferred and reorderFundPreference moves to an index", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "Stocks");
  s = addFund(s, "VTI", "stocks");
  s = addFund(s, "VOO", "stocks");
  s = addFund(s, "VB", "stocks");
  s = addAccount(s, "IRA", "tax_deferred");
  s = setFundAvailability(s, "ira", "vti", true);
  s = setFundAvailability(s, "ira", "voo", true);
  s = setFundAvailability(s, "ira", "vb", true);
  expect(s.portfolio.accounts[0]!.availableFundIds).toEqual(["vti", "voo", "vb"]);

  s = reorderFundPreference(s, "ira", "vb", 0);
  expect(s.portfolio.accounts[0]!.availableFundIds).toEqual(["vb", "vti", "voo"]);

  s = reorderFundPreference(s, "ira", "vb", 1);
  expect(s.portfolio.accounts[0]!.availableFundIds).toEqual(["vti", "vb", "voo"]);

  // Out-of-range targets clamp; unknown funds are a no-op.
  s = reorderFundPreference(s, "ira", "vti", 99);
  expect(s.portfolio.accounts[0]!.availableFundIds).toEqual(["vb", "voo", "vti"]);
  expect(reorderFundPreference(s, "ira", "zzz", 0)).toEqual(s);

  s = setFundAvailability(s, "ira", "voo", false);
  expect(s.portfolio.accounts[0]!.availableFundIds).toEqual(["vb", "vti"]);
});

test("updateAssetClass and updateFund patch in place without changing ids", () => {
  let s = addAssetClass(emptyScenario(), "Stocks");
  s = updateAssetClass(s, "stocks", { name: "Equities", taxPreference: "prefer_taxable" });
  expect(s.portfolio.assetClasses[0]).toEqual({ id: "stocks", name: "Equities", taxPreference: "prefer_taxable" });

  s = addFund(s, "VTI", "stocks");
  s = updateFund(s, "vti", { name: "Vanguard Total Stock Market ETF" });
  expect(s.portfolio.funds[0]).toMatchObject({ id: "vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF" });
});

test("withHolding sets a position value and removes it at zero", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "Stocks");
  s = addFund(s, "VTI", "stocks");
  s = addAccount(s, "IRA", "tax_deferred");
  s = withHolding(s, "ira", "vti", 12345);
  expect(s.portfolio.holdings).toEqual([{ accountId: "ira", fundId: "vti", value: 12345 }]);
  s = withHolding(s, "ira", "vti", 0);
  expect(s.portfolio.holdings).toEqual([]);
});

test("blend updaters: set, add, replace, and remove slices while keeping the total valid", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "US Stocks");
  s = addAssetClass(s, "Intl Stocks");
  s = addAssetClass(s, "Bonds");
  s = addFund(s, "VT", "us-stocks");
  expect(s.portfolio.funds[0]!.assetClasses).toEqual({ "us-stocks": 10000 });

  // Carve the fund into a 65/35 blend: a new slice pre-fills the missing weight.
  s = setFundClassWeight(s, "vt", "us-stocks", 6500);
  s = addFundClass(s, "vt", "intl-stocks");
  expect(s.portfolio.funds[0]!.assetClasses).toEqual({ "us-stocks": 6500, "intl-stocks": 3500 });
  expect(fundWeightTotal(s.portfolio.funds[0]!)).toBe(10000);

  // Point the intl slice at bonds instead, weight intact.
  s = replaceFundClass(s, "vt", "intl-stocks", "bonds");
  expect(s.portfolio.funds[0]!.assetClasses).toEqual({ "us-stocks": 6500, bonds: 3500 });

  // Removing down to one slice bumps the survivor to 100%; the last slice
  // can never be removed.
  s = removeFundClass(s, "vt", "bonds");
  expect(s.portfolio.funds[0]!.assetClasses).toEqual({ "us-stocks": 10000 });
  expect(removeFundClass(s, "vt", "us-stocks")).toEqual(s);

  s = setFundSoleClass(s, "vt", "bonds");
  expect(s.portfolio.funds[0]!.assetClasses).toEqual({ bonds: 10000 });
});

test("removeAssetClass renormalizes surviving blend slices instead of orphaning the fund", () => {
  let s = emptyScenario();
  s = addAssetClass(s, "US Stocks");
  s = addAssetClass(s, "Intl Stocks");
  s = addAssetClass(s, "Bonds");
  s = addFund(s, "VT", "us-stocks");
  s = updateFund(s, "vt", { assetClasses: { "us-stocks": 6000, "intl-stocks": 3000, bonds: 1000 } });

  const pruned = removeAssetClass(s, "bonds");
  // 6000/3000 rescale to 6667/3333 — largest remainder keeps the 10000 total.
  expect(pruned.portfolio.funds[0]!.assetClasses).toEqual({ "us-stocks": 6667, "intl-stocks": 3333 });
});

test("withOptions merges patches and keeps selling flags coherent", () => {
  const selling = withOptions(base, { allowSelling: true });
  expect(selling.options).toEqual({ allowSelling: true });

  // Selling in taxable implies selling at all.
  const taxable = withOptions(base, { sellInTaxableAccounts: true });
  expect(taxable.options).toMatchObject({ allowSelling: true, sellInTaxableAccounts: true });

  // Turning selling off drags the taxable flag down with it.
  const off = withOptions(taxable, { allowSelling: false });
  expect(off.options).toMatchObject({ allowSelling: false, sellInTaxableAccounts: false });

  // Unrelated options survive the merge.
  const tol = withOptions(taxable, { toleranceBps: 0 });
  expect(tol.options).toMatchObject({ allowSelling: true, sellInTaxableAccounts: true, toleranceBps: 0 });
});
