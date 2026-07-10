import { describe, expect, it } from "vitest";
import { allocate } from "./allocate.ts";
import type { TransportationProblem } from "./allocate.ts";

function makeProblem(partial: Partial<TransportationProblem>): TransportationProblem {
  return {
    accounts: [],
    assetClasses: [],
    cash: new Map(),
    demands: new Map(),
    current: new Map(),
    buyable: () => true,
    ...partial,
  };
}

describe("allocate - greedy buy waterfall", () => {
  it("drains the biggest gap first and reports what cash could not reach", () => {
    const result = allocate(
      makeProblem({
        accounts: [{ id: "acct", taxType: "taxable", fallbackAssetClassId: "big" }],
        assetClasses: [
          { id: "big", taxPreference: "neutral" },
          { id: "small", taxPreference: "neutral" },
        ],
        cash: new Map([["acct", 8000]]),
        demands: new Map([
          ["big", 10000],
          ["small", 5000],
        ]),
      }),
    );

    // All $80 goes to the $100 gap; both classes end short and are warned about.
    expect(result.x.get("acct")!.get("big")).toBe(8000);
    expect(result.x.get("acct")!.get("small")).toBeUndefined();
    expect(result.warnings).toEqual([
      { kind: "unreachable_gap", assetClassId: "small", remainingGap: 5000 },
      { kind: "unreachable_gap", assetClassId: "big", remainingGap: 2000 },
    ]);
  });

  it("routes a prefer_tax_advantaged class to the tax-advantaged account even when id order disagrees", () => {
    const result = allocate(
      makeProblem({
        accounts: [
          { id: "a_brokerage", taxType: "taxable", fallbackAssetClassId: "stocks" },
          { id: "z_roth", taxType: "tax_free", fallbackAssetClassId: "stocks" },
        ],
        assetClasses: [
          { id: "bonds", taxPreference: "prefer_tax_advantaged" },
          { id: "stocks", taxPreference: "neutral" },
        ],
        cash: new Map([
          ["a_brokerage", 10000],
          ["z_roth", 10000],
        ]),
        demands: new Map([
          ["bonds", 10000],
          ["stocks", 10000],
        ]),
      }),
    );

    expect(result.x.get("z_roth")!.get("bonds")).toBe(10000);
    expect(result.x.get("a_brokerage")!.get("stocks")).toBe(10000);
  });

  it("sends leftover cash to the fallback class and conserves each account's total", () => {
    const result = allocate(
      makeProblem({
        accounts: [{ id: "acct", taxType: "taxable", fallbackAssetClassId: "stocks" }],
        assetClasses: [
          { id: "bonds", taxPreference: "neutral" },
          { id: "stocks", taxPreference: "neutral" },
        ],
        cash: new Map([["acct", 10000]]),
        demands: new Map([
          ["bonds", 9000],
          ["stocks", 4000],
        ]),
        current: new Map([["acct", new Map([["bonds", 6000]])]]),
        // Only bonds can be bought here; the surplus falls back to stocks.
        buyable: (_accountId, assetClassId) => assetClassId === "bonds",
      }),
    );

    const row = result.x.get("acct")!;
    expect(row.get("bonds")).toBe(9000);
    expect(row.get("stocks")).toBe(7000);
    const total = [...row.values()].reduce((sum, v) => sum + v, 0);
    expect(total).toBe(6000 + 10000);
    expect(result.warnings).toContainEqual({
      kind: "leftover_cash",
      accountId: "acct",
      assetClassId: "stocks",
      amount: 7000,
    });
  });
});
