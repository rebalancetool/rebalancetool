import { describe, expect, it } from "vitest";
import { validateScenario } from "./scenario.ts";
import { rebalance } from "./rebalance.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };
import sellRequiredFixtureRaw from "../fixtures/sell-required.json" with { type: "json" };

function minimalScenario(): Record<string, unknown> {
  return {
    portfolio: {
      assetClasses: [{ id: "stocks", name: "Stocks" }],
      funds: [{ id: "vti", name: "VTI", assetClasses: { stocks: 10000 } }],
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

  it("rejects the removed options.optimizer with a hint", () => {
    const doc = minimalScenario();
    (doc.options as Record<string, unknown>).optimizer = "greedy";
    expect(() => validateScenario(doc)).toThrow(/"options\.optimizer" was removed/);
  });

  it("gives a migration hint for the old single-class fund format", () => {
    const doc = minimalScenario();
    (doc.portfolio as { funds: unknown[] }).funds = [{ id: "vti", name: "VTI", assetClassId: "stocks" }];
    expect(() => validateScenario(doc)).toThrow(/old single-class fund format.*"stocks": 10000/s);
  });

  it("accepts blended funds and rejects non-numeric weights", () => {
    const doc = minimalScenario();
    (doc.portfolio as { funds: unknown[]; assetClasses: unknown[] }).assetClasses = [
      { id: "stocks", name: "Stocks" },
      { id: "intl", name: "Intl" },
    ];
    (doc.portfolio as { funds: unknown[] }).funds = [
      { id: "vt", name: "VT", assetClasses: { stocks: 6500, intl: 3500 } },
    ];
    (doc.portfolio as { accounts: Array<{ availableFundIds: string[] }> }).accounts[0]!.availableFundIds = ["vt"];
    (doc.portfolio as { holdings: Array<{ fundId: string }> }).holdings[0]!.fundId = "vt";
    expect(validateScenario(doc).portfolio.funds[0]!.assetClasses).toEqual({ stocks: 6500, intl: 3500 });

    (doc.portfolio as { funds: Array<{ assetClasses: unknown }> }).funds[0]!.assetClasses = { stocks: "6500" };
    expect(() => validateScenario(doc)).toThrow(/funds\[0\]\.assetClasses\["stocks"\]/);
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

  it("rejects unknown keys inside every array-element record, so nested typos fail loudly too", () => {
    const cases: Array<[string, (doc: Record<string, unknown>) => void, RegExp]> = [
      [
        "asset class",
        (doc) => {
          (doc.portfolio as { assetClasses: Array<Record<string, unknown>> }).assetClasses[0]!.taxPrefernce =
            "prefer_taxable";
        },
        /Unknown key "taxPrefernce" in portfolio\.assetClasses\[0\]/,
      ],
      [
        "fund",
        (doc) => {
          (doc.portfolio as { funds: Array<Record<string, unknown>> }).funds[0]!.tikcer = "VTI";
        },
        /Unknown key "tikcer" in portfolio\.funds\[0\]/,
      ],
      [
        "account",
        (doc) => {
          (doc.portfolio as { accounts: Array<Record<string, unknown>> }).accounts[0]!.taxTyp = "taxable";
        },
        /Unknown key "taxTyp" in portfolio\.accounts\[0\]/,
      ],
      [
        "holding",
        (doc) => {
          (doc.portfolio as { holdings: Array<Record<string, unknown>> }).holdings[0]!.cost_basis = 1;
        },
        /Unknown key "cost_basis" in portfolio\.holdings\[0\]/,
      ],
      [
        "target",
        (doc) => {
          (doc.targets as Array<Record<string, unknown>>)[0]!.wieght = 10000;
        },
        /Unknown key "wieght" in targets\[0\]/,
      ],
      [
        "contribution",
        (doc) => {
          (doc.contributions as Array<Record<string, unknown>>)[0]!.ammount = 1;
        },
        /Unknown key "ammount" in contributions\[0\]/,
      ],
    ];
    for (const [, mutate, expected] of cases) {
      const doc = minimalScenario();
      mutate(doc);
      expect(() => validateScenario(doc)).toThrow(expected);
    }

    // Underscore-prefixed comment keys stay legal inside records too.
    const commented = minimalScenario();
    (commented.portfolio as { funds: Array<Record<string, unknown>> }).funds[0]!._note = "my 401k fund";
    expect(() => validateScenario(commented)).not.toThrow();
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
