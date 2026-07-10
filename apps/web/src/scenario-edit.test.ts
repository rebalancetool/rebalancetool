import type { Scenario } from "@rebalancer/solver";
import { expect, test } from "vitest";
import { targetWeightTotal, withContribution, withOptions, withTargetWeight } from "./scenario-edit.ts";

const base: Scenario = {
  portfolio: {
    assetClasses: [
      { id: "stocks", name: "Stocks" },
      { id: "bonds", name: "Bonds" },
    ],
    funds: [{ id: "vti", name: "VTI", assetClassId: "stocks" }],
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
