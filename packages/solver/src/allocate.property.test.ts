import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateLp } from "./allocate.lp.ts";
import type { TransportationProblem } from "./allocate.ts";

/**
 * Brute-force reference for the allocator: on portfolios small enough to
 * enumerate every feasible placement, allocateLp() must reach the minimum
 * achievable total deviation Σ_c |final[c] - demand[c]|, modulo the
 * documented float→integer rounding slack (< 1 cent per position).
 *
 * Three regimes, together covering everything the old greedy-vs-lp
 * differential did and more (the brute force finds the *true* optimum, not
 * another heuristic's achievable bar):
 *  - a single account with arbitrary buyable/sellable constraints;
 *  - multiple accounts with no constraints at all (everything buyable and
 *    sellable), where the exact target is always reachable;
 *  - two accounts with arbitrary per-account buy/sell constraints — the
 *    cross-account contention case.
 *
 * Funds are one-per-class with the class's id (see allocate.lp.test.ts), so
 * problems and results read in class space.
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

/** Every way to place `total` cents across the three classes. */
function* compositions(total: number): Generator<[number, number, number]> {
  for (let a = 0; a <= total; a++) {
    for (let b = 0; b <= total - a; b++) {
      yield [a, b, total - a - b];
    }
  }
}

/** Whether one account may move from `holdings` to `candidate` under its buy/sell flags. */
function feasible(
  candidate: readonly number[],
  holdings: readonly number[],
  buyable: boolean[],
  sellable: boolean[],
): boolean {
  for (let i = 0; i < CLASS_IDS.length; i++) {
    const delta = candidate[i]! - holdings[i]!;
    if (delta > 0 && !buyable[i]!) return false;
    if (delta < 0 && !sellable[i]!) return false;
  }
  return true;
}

// The LP's float→integer repair conserves account totals exactly but can
// shift a class total by strictly less than one cent per position, so its
// integer deviation may exceed the true optimum by up to
// (#classes × #accounts) cents. Any rounded solution still respects the
// buy/sell bounds, so it can never *beat* the brute-force optimum.
describe("allocateLp - brute-force optimality (fast-check)", () => {
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
          // rejected the input before the allocator ever ran.
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

          const achievedDeviation = deviationOf(allocateLp(problem).x, demands);

          let best = Number.POSITIVE_INFINITY;
          for (const candidate of compositions(total)) {
            if (!feasible(candidate, holdings, buyableFlags, sellableFlags)) continue;
            const deviation = candidate.reduce((s, v, i) => s + Math.abs(v - demands[i]!), 0);
            if (deviation < best) best = deviation;
          }

          expect(achievedDeviation).toBeGreaterThanOrEqual(best);
          expect(achievedDeviation).toBeLessThanOrEqual(best + CLASS_IDS.length);
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

          const achievedDeviation = deviationOf(allocateLp(problem).x, demands);
          expect(achievedDeviation).toBeLessThanOrEqual(2 * CLASS_IDS.length);
        },
      ),
    );
  });

  it("two constrained accounts: reaches the brute-force minimum and never sells a class below demand", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 4 }), { minLength: 6, maxLength: 6 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 2, maxLength: 2 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        (flatHoldings, cashes, buyableFlags, sellableFlags, cutSeedA, cutSeedB) => {
          // Each account needs somewhere for its cash, or rebalance() would
          // have rejected the input before the allocator ever ran.
          if (cashes[0]! > 0 && !buyableFlags.slice(0, 3).some(Boolean)) buyableFlags[0] = true;
          if (cashes[1]! > 0 && !buyableFlags.slice(3).some(Boolean)) buyableFlags[3] = true;

          const total = flatHoldings.reduce((s, v) => s + v, 0) + cashes.reduce((s, v) => s + v, 0);
          const demands = threeWaySplit(total, cutSeedA, cutSeedB);
          const accountIds = ["acct_a", "acct_b"];
          const flagIndex = (accountId: string, fundId: string): number =>
            (accountId === "acct_a" ? 0 : 3) + CLASS_IDS.indexOf(fundId as never);

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

          const lp = allocateLp(problem);
          const lpDeviation = deviationOf(lp.x, demands);

          // Brute force every joint composition: each account independently
          // recomposes its own fixed total under its own buy/sell flags, and
          // the deviation couples them through the global class totals.
          const holdingsA = flatHoldings.slice(0, 3);
          const holdingsB = flatHoldings.slice(3);
          const totalA = holdingsA.reduce((s, v) => s + v, 0) + cashes[0]!;
          const totalB = holdingsB.reduce((s, v) => s + v, 0) + cashes[1]!;
          const buyableA = buyableFlags.slice(0, 3);
          const buyableB = buyableFlags.slice(3);
          const sellableA = sellableFlags.slice(0, 3);
          const sellableB = sellableFlags.slice(3);

          let best = Number.POSITIVE_INFINITY;
          for (const compA of compositions(totalA)) {
            if (!feasible(compA, holdingsA, buyableA, sellableA)) continue;
            for (const compB of compositions(totalB)) {
              if (!feasible(compB, holdingsB, buyableB, sellableB)) continue;
              let deviation = 0;
              for (let i = 0; i < CLASS_IDS.length; i++) {
                deviation += Math.abs(compA[i]! + compB[i]! - demands[i]!);
              }
              if (deviation < best) best = deviation;
            }
          }

          expect(lpDeviation).toBeGreaterThanOrEqual(best);
          expect(lpDeviation).toBeLessThanOrEqual(best + accountIds.length * CLASS_IDS.length);

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
