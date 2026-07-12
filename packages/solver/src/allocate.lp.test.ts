import { describe, expect, it } from "vitest";
import { allocateLp } from "./allocate.lp.ts";
import type { TransportationProblem } from "./allocate.ts";

/**
 * Seam-level contracts of the allocator, in class-space terms: each asset
 * class gets exactly one single-class fund whose id *is* the class id, so
 * `current` and `x` read the same whether you think in funds or classes.
 * Only behaviors the seam promises are tested here — placements that are
 * merely one of several equal optima belong in the property tests.
 */
function makeProblem(partial: Partial<TransportationProblem>): TransportationProblem {
  return {
    accounts: [],
    assetClasses: [],
    funds: (partial.assetClasses ?? []).map((c) => ({ id: c.id, weights: new Map([[c.id, 10000]]) })),
    cash: new Map(),
    demands: new Map(),
    current: new Map(),
    buyable: () => true,
    sellable: () => 0,
    preferenceRank: () => 0,
    toleranceCents: 0,
    minTradeCents: 0,
    ...partial,
  };
}

describe("allocateLp - buying", () => {
  it("routes a prefer_tax_advantaged class to the tax-advantaged account even when id order disagrees", () => {
    const result = allocateLp(
      makeProblem({
        accounts: [
          { id: "a_brokerage", taxType: "taxable" },
          { id: "z_roth", taxType: "tax_free" },
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

  it("sends surplus cash to the most-preferred fund and conserves each account's total", () => {
    const result = allocateLp(
      makeProblem({
        accounts: [{ id: "acct", taxType: "taxable" }],
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
        // stocks is the account's most-preferred fund, so once every gap is
        // closed the 3000 surplus lands there (the fund-preference stage).
        preferenceRank: (_accountId, fundId) => (fundId === "stocks" ? 0 : 1),
      }),
    );

    const row = result.x.get("acct")!;
    expect(row.get("bonds")).toBe(9000);
    expect(row.get("stocks")).toBe(7000);
    const total = [...row.values()].reduce((sum, v) => sum + v, 0);
    expect(total).toBe(6000 + 10000);
    // Surplus is not warning-worthy: the tables show where it went.
    expect(result.warnings).toEqual([]);
  });
});

describe("allocateLp - selling", () => {
  it("never sells a class below its portfolio-level demand, even across accounts", () => {
    const result = allocateLp(
      makeProblem({
        accounts: [
          { id: "acct_a", taxType: "tax_free" },
          { id: "acct_b", taxType: "tax_free" },
        ],
        assetClasses: [
          { id: "c", taxPreference: "neutral" },
          { id: "d", taxPreference: "neutral" },
        ],
        demands: new Map([
          ["c", 6000],
          ["d", 9000],
        ]),
        current: new Map([
          ["acct_a", new Map([["d", 10000]])],
          ["acct_b", new Map([["d", 5000]])],
        ]),
        // Only acct_a can buy the underweight class.
        buyable: (accountId, fundId) => fundId !== "c" || accountId === "acct_a",
        sellable: () => Number.MAX_SAFE_INTEGER,
      }),
    );

    // d's global excess is 15000 - 9000 = 6000; exactly that much is sold,
    // all in acct_a, leaving d at its demand.
    expect(result.x.get("acct_a")!.get("d")).toBe(4000);
    expect(result.x.get("acct_a")!.get("c")).toBe(6000);
    expect(result.x.get("acct_b")!.get("d")).toBe(5000);
    expect(result.warnings).toEqual([]);
  });

  it("stops selling when the buying account runs out of overweight holdings and warns", () => {
    const result = allocateLp(
      makeProblem({
        accounts: [
          { id: "acct_a", taxType: "tax_free" },
          { id: "acct_b", taxType: "tax_free" },
        ],
        assetClasses: [
          { id: "c", taxPreference: "neutral" },
          { id: "d", taxPreference: "neutral" },
        ],
        demands: new Map([
          ["c", 6000],
          ["d", 9000],
        ]),
        current: new Map([
          ["acct_a", new Map([["d", 3000]])],
          ["acct_b", new Map([["d", 12000]])],
        ]),
        buyable: (accountId, fundId) => fundId !== "c" || accountId === "acct_a",
        sellable: () => Number.MAX_SAFE_INTEGER,
      }),
    );

    // acct_a can only raise 3000 by selling everything it holds of d; the
    // rest of c's gap is unreachable because acct_b cannot buy c.
    expect(result.x.get("acct_a")!.get("d")).toBe(0);
    expect(result.x.get("acct_a")!.get("c")).toBe(3000);
    expect(result.x.get("acct_b")!.get("d")).toBe(12000);
    expect(result.warnings).toEqual([{ kind: "unreachable_gap", assetClassId: "c", remainingGap: 3000 }]);
  });

  it("prefers selling in a tax-advantaged account even when id order disagrees", () => {
    const result = allocateLp(
      makeProblem({
        accounts: [
          { id: "a_taxable", taxType: "taxable" },
          { id: "z_ira", taxType: "tax_deferred" },
        ],
        assetClasses: [
          { id: "c", taxPreference: "neutral" },
          { id: "d", taxPreference: "neutral" },
        ],
        demands: new Map([
          ["c", 5000],
          ["d", 11000],
        ]),
        current: new Map([
          ["a_taxable", new Map([["d", 8000]])],
          ["z_ira", new Map([["d", 8000]])],
        ]),
        sellable: () => Number.MAX_SAFE_INTEGER,
      }),
    );

    expect(result.x.get("z_ira")!.get("d")).toBe(3000);
    expect(result.x.get("z_ira")!.get("c")).toBe(5000);
    expect(result.x.get("a_taxable")!.get("d")).toBe(8000);
  });

  it("sells nothing when every sellable cap is zero", () => {
    const result = allocateLp(
      makeProblem({
        accounts: [{ id: "acct", taxType: "tax_free" }],
        assetClasses: [
          { id: "c", taxPreference: "neutral" },
          { id: "d", taxPreference: "neutral" },
        ],
        demands: new Map([
          ["c", 4000],
          ["d", 6000],
        ]),
        current: new Map([["acct", new Map([["d", 10000]])]]),
        sellable: () => 0,
      }),
    );

    expect(result.x.get("acct")!.get("d")).toBe(10000);
    expect(result.warnings).toEqual([{ kind: "unreachable_gap", assetClassId: "c", remainingGap: 4000 }]);
  });
});
