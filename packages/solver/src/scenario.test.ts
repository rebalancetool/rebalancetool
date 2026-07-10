import { describe, expect, it } from "vitest";
import { validateScenario } from "./scenario.ts";
import { rebalance } from "./rebalance.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };
import sellRequiredFixtureRaw from "../fixtures/sell-required.json" with { type: "json" };

function minimalScenario(): Record<string, unknown> {
  return {
    portfolio: {
      assetClasses: [{ id: "stocks", name: "Stocks" }],
      funds: [{ id: "vti", name: "VTI", assetClassId: "stocks" }],
      accounts: [{ id: "acct", name: "Account", taxType: "taxable", availableFundIds: ["vti"] }],
      holdings: [{ accountId: "acct", fundId: "vti", value: 1000 }],
    },
    targets: [{ assetClassId: "stocks", weight: 10000 }],
    contributions: [{ accountId: "acct", amount: 500 }],
    options: { allowSelling: true, toleranceBps: 0 },
  };
}

describe("validateScenario", () => {
  it("accepts the checked-in fixtures and feeds rebalance() directly", () => {
    for (const raw of [exampleFixtureRaw, sellRequiredFixtureRaw]) {
      const scenario = validateScenario(raw);
      const result = rebalance(scenario.portfolio, scenario.targets, {
        contributions: scenario.contributions,
        ...scenario.options,
      });
      expect(result.trades.length).toBeGreaterThan(0);
    }
  });

  it("returns a typed copy of a valid document", () => {
    const scenario = validateScenario(minimalScenario());
    expect(scenario.portfolio.accounts[0]!.taxType).toBe("taxable");
    expect(scenario.contributions).toEqual([{ accountId: "acct", amount: 500 }]);
    expect(scenario.options).toEqual({ allowSelling: true, toleranceBps: 0 });
  });

  it("defaults contributions to an empty array when omitted", () => {
    const doc = minimalScenario();
    delete doc.contributions;
    expect(validateScenario(doc).contributions).toEqual([]);
  });

  it("gives a migration hint for the old flat format", () => {
    const doc = minimalScenario();
    const flat = { ...(doc.portfolio as Record<string, unknown>), targets: doc.targets };
    expect(() => validateScenario(flat)).toThrow(/old flat\s+format/);
  });

  it("rejects unknown keys, except underscore-prefixed comments", () => {
    const withComment = { ...minimalScenario(), _comment: "fine" };
    expect(() => validateScenario(withComment)).not.toThrow();

    const withTypo = { ...minimalScenario(), option: {} };
    expect(() => validateScenario(withTypo)).toThrow(/Unknown key "option"/);

    const badOption = minimalScenario();
    badOption.options = { allowSeling: true };
    expect(() => validateScenario(badOption)).toThrow(/Unknown key "allowSeling" in options/);
  });

  it("rejects wrong primitive types and bad enum values with the offending path", () => {
    const badTaxType = minimalScenario();
    (badTaxType.portfolio as { accounts: Array<{ taxType: string }> }).accounts[0]!.taxType = "roth";
    expect(() => validateScenario(badTaxType)).toThrow(/portfolio\.accounts\[0\]\.taxType/);

    const badValue = minimalScenario();
    (badValue.portfolio as { holdings: Array<{ value: unknown }> }).holdings[0]!.value = "1000";
    expect(() => validateScenario(badValue)).toThrow(/portfolio\.holdings\[0\]\.value/);

    const badTargets = minimalScenario();
    badTargets.targets = { assetClassId: "stocks", weight: 10000 };
    expect(() => validateScenario(badTargets)).toThrow(/Expected targets to be an array/);
  });
});
