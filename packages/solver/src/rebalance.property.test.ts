import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rebalance } from "./rebalance.ts";
import type { Account, AssetClass, Contribution, Fund, Holding, Portfolio, Target } from "./types.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };

interface ExampleFixture {
  assetClasses: AssetClass[];
  funds: Fund[];
  accounts: Account[];
  holdings: Holding[];
}

const fixture = exampleFixtureRaw as unknown as ExampleFixture;
const assetClassIds = fixture.assetClasses.map((a) => a.id);
const accountIds = fixture.accounts.map((a) => a.id);

/** Deterministic Fisher-Yates so a given seed always yields the same permutation. */
function shuffled<T>(arr: T[], seed: number): T[] {
  const copy = [...arr];
  let state = seed || 1;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}

/** Turns arbitrary positive weights into basis points that sum to exactly 10000. */
function makeTargets(rawWeights: number[]): Target[] {
  const total = rawWeights.reduce((sum, w) => sum + w, 0);
  const bps = rawWeights.map((w) => Math.floor((w * 10000) / total));
  let remainder = 10000 - bps.reduce((sum, b) => sum + b, 0);
  let i = 0;
  while (remainder > 0) {
    bps[i % bps.length]! += 1;
    remainder -= 1;
    i += 1;
  }
  return assetClassIds.map((id, idx) => ({ assetClassId: id, weight: bps[idx]! }));
}

const rawWeightsArb = fc.array(fc.integer({ min: 1, max: 100 }), {
  minLength: assetClassIds.length,
  maxLength: assetClassIds.length,
});
const amountsArb = fc.array(fc.integer({ min: 0, max: 2_000_000 }), {
  minLength: accountIds.length,
  maxLength: accountIds.length,
});

function buildContributions(amounts: number[]): Contribution[] {
  return accountIds.map((accountId, i) => ({ accountId, amount: amounts[i]! }));
}

describe("rebalance - properties (fast-check)", () => {
  it("never emits anything but a buy", () => {
    fc.assert(
      fc.property(rawWeightsArb, amountsArb, (rawWeights, amounts) => {
        const portfolio: Portfolio = { ...fixture };
        const result = rebalance(portfolio, makeTargets(rawWeights), {
          contributions: buildContributions(amounts),
        });
        return result.trades.every((t) => t.action === "buy");
      }),
    );
  });

  it("conserves per-account totals: trades into an account sum exactly to that account's contribution", () => {
    fc.assert(
      fc.property(rawWeightsArb, amountsArb, (rawWeights, amounts) => {
        const portfolio: Portfolio = { ...fixture };
        const contributions = buildContributions(amounts);
        const result = rebalance(portfolio, makeTargets(rawWeights), { contributions });

        for (const accountId of accountIds) {
          const contributed = contributions.find((c) => c.accountId === accountId)!.amount;
          const traded = result.trades.filter((t) => t.accountId === accountId).reduce((s, t) => s + t.amount, 0);
          expect(traded).toBe(contributed);
        }
      }),
    );
  });

  it("is deterministic no matter how input arrays are ordered", () => {
    fc.assert(
      fc.property(
        rawWeightsArb,
        amountsArb,
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (rawWeights, amounts, seed) => {
          const targets = makeTargets(rawWeights);
          const contributions = buildContributions(amounts);
          const portfolio: Portfolio = { ...fixture };

          const baseline = rebalance(portfolio, targets, { contributions });

          const shuffledPortfolio: Portfolio = {
            assetClasses: shuffled(portfolio.assetClasses, seed),
            funds: shuffled(portfolio.funds, seed + 1),
            accounts: shuffled(portfolio.accounts, seed + 2),
            holdings: shuffled(portfolio.holdings, seed + 3),
          };
          const reordered = rebalance(shuffledPortfolio, shuffled(targets, seed + 4), {
            contributions: shuffled(contributions, seed + 5),
          });

          expect(reordered).toEqual(baseline);
        },
      ),
    );
  });
});
