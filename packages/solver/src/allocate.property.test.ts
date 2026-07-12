import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocate } from "./allocate.ts";
import { allocateLp } from "./allocate.lp.ts";
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

// roundingSlack: the LP's float→integer repair conserves account totals
// exactly but can shift a class total by strictly less than one cent per
// account, so its integer deviation may exceed the true optimum by up to
// (#classes × #accounts − 1) cents. Greedy works in integers throughout.
describe.each([
  ["greedy", allocate, 0],
  ["lp", allocateLp, 1],
] as const)("allocate (%s) - brute-force optimality (fast-check)", (_name, allocateImpl, roundingSlack) => {
  it("single account: reaches the brute-force minimum deviation under any buy/sell constraints", () => {
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

          const total = holdings.reduce((s, v) => s + v, 0) + cash;
          const demands = threeWaySplit(total, cutSeedA, cutSeedB);

          const problem: TransportationProblem = {
            accounts: [{ id: "acct", taxType: "tax_free" }],
            assetClasses: CLASS_IDS.map((id) => ({ id, taxPreference: "neutral" })),
            funds: CLASS_IDS.map((id) => ({ id, weights: new Map([[id, 10000]]) })),
            cash: new Map([["acct", cash]]),
            demands: new Map(CLASS_IDS.map((id, i) => [id, demands[i]!])),
            current: new Map([["acct", new Map(CLASS_IDS.map((id, i) => [id, holdings[i]!]))]]),
            buyable: (_accountId, fundId) => buyableFlags[CLASS_IDS.indexOf(fundId as never)]!,
            sellable: (_accountId, fundId) =>
              sellableFlags[CLASS_IDS.indexOf(fundId as never)]! ? Number.MAX_SAFE_INTEGER : 0,
            preferenceRank: () => 0,
            toleranceCents: 0,
            minTradeCents: 0,
          };

          const achievedDeviation = deviationOf(allocateImpl(problem).x, demands);

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

          expect(achievedDeviation).toBeGreaterThanOrEqual(best);
          expect(achievedDeviation).toBeLessThanOrEqual(best + roundingSlack * CLASS_IDS.length);
        },
      ),
    );
  });

  it("two unconstrained accounts: always reaches the target exactly", () => {
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
              { id: "acct_a", taxType: "taxable" },
              { id: "acct_b", taxType: "tax_free" },
            ],
            assetClasses: CLASS_IDS.map((id) => ({ id, taxPreference: "neutral" })),
            funds: CLASS_IDS.map((id) => ({ id, weights: new Map([[id, 10000]]) })),
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
            preferenceRank: () => 0,
            toleranceCents: 0,
            minTradeCents: 0,
          };

          const achievedDeviation = deviationOf(allocateImpl(problem).x, demands);
          expect(achievedDeviation).toBeLessThanOrEqual(roundingSlack * 2 * CLASS_IDS.length);
        },
      ),
    );
  });
});

describe("allocate - lp vs greedy (fast-check)", () => {
  // On constrained multi-account problems the greedy can be marginally
  // suboptimal (cross-account contention); the LP never may be. It must
  // match or beat greedy everywhere while honoring the same constraints.
  it("lp deviation is never worse than greedy's, and lp never sells a class below demand", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 5 }), { minLength: 6, maxLength: 6 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 2, maxLength: 2 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        (flatHoldings, cashes, buyableFlags, sellableFlags, cutSeedA, cutSeedB) => {
          // Each account needs somewhere for its cash, or rebalance() would
          // have rejected the input before allocate() ever ran.
          if (cashes[0]! > 0 && !buyableFlags.slice(0, 3).some(Boolean)) buyableFlags[0] = true;
          if (cashes[1]! > 0 && !buyableFlags.slice(3).some(Boolean)) buyableFlags[3] = true;

          const total = flatHoldings.reduce((s, v) => s + v, 0) + cashes.reduce((s, v) => s + v, 0);
          const demands = threeWaySplit(total, cutSeedA, cutSeedB);
          const accountIds = ["acct_a", "acct_b"];
          const flagIndex = (accountId: string, assetClassId: string): number =>
            (accountId === "acct_a" ? 0 : 3) + CLASS_IDS.indexOf(assetClassId as never);

          const problem: TransportationProblem = {
            accounts: [
              { id: "acct_a", taxType: "taxable" },
              { id: "acct_b", taxType: "tax_free" },
            ],
            assetClasses: CLASS_IDS.map((id) => ({ id, taxPreference: "neutral" })),
            funds: CLASS_IDS.map((id) => ({ id, weights: new Map([[id, 10000]]) })),
            cash: new Map([
              ["acct_a", cashes[0]!],
              ["acct_b", cashes[1]!],
            ]),
            demands: new Map(CLASS_IDS.map((id, i) => [id, demands[i]!])),
            current: new Map(
              accountIds.map((accountId, a) => [
                accountId,
                new Map(CLASS_IDS.map((id, i) => [id, flatHoldings[a * 3 + i]!])),
              ]),
            ),
            buyable: (accountId, fundId) => buyableFlags[flagIndex(accountId, fundId)]!,
            sellable: (accountId, fundId) =>
              sellableFlags[flagIndex(accountId, fundId)]! ? Number.MAX_SAFE_INTEGER : 0,
            preferenceRank: () => 0,
            toleranceCents: 0,
            minTradeCents: 0,
          };

          // Rounding can cost the LP strictly less than one cent per
          // account per class; beyond that it must match or beat greedy.
          const roundingSlack = accountIds.length * CLASS_IDS.length;
          const greedyDeviation = deviationOf(allocate(problem).x, demands);
          const lp = allocateLp(problem);
          const lpDeviation = deviationOf(lp.x, demands);
          expect(lpDeviation).toBeLessThanOrEqual(greedyDeviation + roundingSlack);

          // Never-sell-below-demand: a class's total only drops toward,
          // never past, its demand (again modulo per-account rounding).
          CLASS_IDS.forEach((classId, i) => {
            let currentTotal = 0;
            let finalTotal = 0;
            for (const accountId of accountIds) {
              currentTotal += flatHoldings[flagIndex(accountId, classId)]!;
              finalTotal += lp.x.get(accountId)!.get(classId) ?? 0;
            }
            expect(finalTotal).toBeGreaterThanOrEqual(Math.min(currentTotal, demands[i]!) - accountIds.length);
          });
        },
      ),
    );
  });
});
