import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocate } from "./allocate.ts";
import type { TransportationProblem } from "./allocate.ts";

/**
 * Brute-force reference for the greedy allocate(): on portfolios small
 * enough to enumerate every feasible placement, greedy must reach the
 * minimum achievable total deviation Σ_c |final[c] - demand[c]|.
 *
 * Two regimes where greedy is expected to be *exactly* optimal:
 *  - a single account with arbitrary buyable/sellable constraints (no
 *    cross-account contention is possible), checked against brute force;
 *  - multiple accounts with no constraints at all (everything buyable and
 *    sellable), where the exact target is always reachable.
 *
 * Deliberately contrived cross-account contention can make greedy
 * marginally suboptimal (documented in the plan); an LP-backed allocate()
 * swapped in behind the same seam would have to pass these same tests.
 */

const CLASS_IDS = ["c0", "c1", "c2"] as const;

function deviationOf(x: Map<string, Map<string, number>>, demands: number[]): number {
  let deviation = 0;
  CLASS_IDS.forEach((classId, i) => {
    let held = 0;
    for (const row of x.values()) held += row.get(classId) ?? 0;
    deviation += Math.abs(held - demands[i]!);
  });
  return deviation;
}

/** Splits `total` into three non-negative parts using two random cut points. */
function threeWaySplit(total: number, cutSeedA: number, cutSeedB: number): number[] {
  const u1 = total === 0 ? 0 : cutSeedA % (total + 1);
  const u2 = total === 0 ? 0 : cutSeedB % (total + 1);
  const lo = Math.min(u1, u2);
  const hi = Math.max(u1, u2);
  return [lo, hi - lo, total - hi];
}

describe("allocate - brute-force optimality (fast-check)", () => {
  it("single account: greedy reaches the brute-force minimum deviation under any buy/sell constraints", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 6 }), { minLength: 3, maxLength: 3 }),
        fc.nat({ max: 5 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        (holdings, cash, buyableFlags, sellableFlags, cutSeedA, cutSeedB) => {
          // Cash must be investable somewhere, or rebalance() would have
          // rejected the input before allocate() ever ran.
          if (cash > 0 && !buyableFlags.some(Boolean)) buyableFlags[0] = true;
          const fallbackIndex = buyableFlags.findIndex(Boolean);

          const total = holdings.reduce((s, v) => s + v, 0) + cash;
          const demands = threeWaySplit(total, cutSeedA, cutSeedB);

          const problem: TransportationProblem = {
            accounts: [
              {
                id: "acct",
                taxType: "tax_free",
                fallbackAssetClassId: fallbackIndex === -1 ? undefined : CLASS_IDS[fallbackIndex],
              },
            ],
            assetClasses: CLASS_IDS.map((id) => ({ id, taxPreference: "neutral" })),
            cash: new Map([["acct", cash]]),
            demands: new Map(CLASS_IDS.map((id, i) => [id, demands[i]!])),
            current: new Map([["acct", new Map(CLASS_IDS.map((id, i) => [id, holdings[i]!]))]]),
            buyable: (_accountId, assetClassId) => buyableFlags[CLASS_IDS.indexOf(assetClassId as never)]!,
            sellable: (_accountId, assetClassId) =>
              sellableFlags[CLASS_IDS.indexOf(assetClassId as never)]! ? Number.MAX_SAFE_INTEGER : 0,
            toleranceCents: 0,
            minTradeCents: 0,
          };

          const greedyDeviation = deviationOf(allocate(problem).x, demands);

          // Brute force every composition of `total` into the three classes.
          let best = Number.POSITIVE_INFINITY;
          for (let a = 0; a <= total; a++) {
            for (let b = 0; b <= total - a; b++) {
              const candidate = [a, b, total - a - b];
              let feasible = true;
              for (let i = 0; i < 3; i++) {
                const delta = candidate[i]! - holdings[i]!;
                if (delta > 0 && !buyableFlags[i]!) feasible = false;
                if (delta < 0 && !sellableFlags[i]!) feasible = false;
              }
              if (!feasible) continue;
              const deviation = candidate.reduce((s, v, i) => s + Math.abs(v - demands[i]!), 0);
              if (deviation < best) best = deviation;
            }
          }

          expect(greedyDeviation).toBe(best);
        },
      ),
    );
  });

  it("two unconstrained accounts: greedy always reaches the target exactly", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 4 }), { minLength: 6, maxLength: 6 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 2, maxLength: 2 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        (flatHoldings, cashes, cutSeedA, cutSeedB) => {
          const total = flatHoldings.reduce((s, v) => s + v, 0) + cashes.reduce((s, v) => s + v, 0);
          const demands = threeWaySplit(total, cutSeedA, cutSeedB);

          const problem: TransportationProblem = {
            accounts: [
              { id: "acct_a", taxType: "taxable", fallbackAssetClassId: "c0" },
              { id: "acct_b", taxType: "tax_free", fallbackAssetClassId: "c0" },
            ],
            assetClasses: CLASS_IDS.map((id) => ({ id, taxPreference: "neutral" })),
            cash: new Map([
              ["acct_a", cashes[0]!],
              ["acct_b", cashes[1]!],
            ]),
            demands: new Map(CLASS_IDS.map((id, i) => [id, demands[i]!])),
            current: new Map([
              ["acct_a", new Map(CLASS_IDS.map((id, i) => [id, flatHoldings[i]!]))],
              ["acct_b", new Map(CLASS_IDS.map((id, i) => [id, flatHoldings[3 + i]!]))],
            ]),
            buyable: () => true,
            sellable: () => Number.MAX_SAFE_INTEGER,
            toleranceCents: 0,
            minTradeCents: 0,
          };

          const greedyDeviation = deviationOf(allocate(problem).x, demands);
          expect(greedyDeviation).toBe(0);
        },
      ),
    );
  });
});
