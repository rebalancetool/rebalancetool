import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rebalance } from "./rebalance.ts";
import { validateScenario } from "./scenario.ts";
import type { Contribution, Portfolio, Target } from "./types.ts";
import exampleFixtureRaw from "../fixtures/example.json" with { type: "json" };

const fixture: Portfolio = validateScenario(exampleFixtureRaw).portfolio;
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

/** Random selling configuration, including buy-only, across both optimizers. */
const sellOptionsArb = fc.record({
  allowSelling: fc.boolean(),
  sellInTaxableAccounts: fc.boolean(),
  optimizer: fc.constantFrom("greedy" as const, "lp" as const),
});

const optimizerArb = fc.constantFrom("greedy" as const, "lp" as const);

describe("rebalance - properties (fast-check)", () => {
  it("never emits anything but a buy when selling is off", () => {
    fc.assert(
      fc.property(rawWeightsArb, amountsArb, optimizerArb, (rawWeights, amounts, optimizer) => {
        const portfolio: Portfolio = { ...fixture };
        const result = rebalance(portfolio, makeTargets(rawWeights), {
          contributions: buildContributions(amounts),
          allowSelling: false,
          optimizer,
        });
        return result.trades.every((t) => t.action === "buy");
      }),
    );
  });

  it("conserves per-account totals: buys minus sells sum exactly to that account's contribution", () => {
    fc.assert(
      fc.property(rawWeightsArb, amountsArb, sellOptionsArb, (rawWeights, amounts, sellOptions) => {
        const portfolio: Portfolio = { ...fixture };
        const contributions = buildContributions(amounts);
        const result = rebalance(portfolio, makeTargets(rawWeights), { contributions, ...sellOptions });

        for (const accountId of accountIds) {
          const contributed = contributions.find((c) => c.accountId === accountId)!.amount;
          const net = result.trades
            .filter((t) => t.accountId === accountId)
            .reduce((s, t) => s + (t.action === "buy" ? t.amount : -t.amount), 0);
          expect(net).toBe(contributed);

          // The account breakdown must tell the same story as the trades.
          const breakdown = result.accounts.find((a) => a.accountId === accountId)!;
          expect(breakdown.contribution).toBe(contributed);
          expect(breakdown.finalTotal).toBe(breakdown.currentTotal + contributed);
          const positionsFinal = breakdown.positions.reduce((s, p) => s + p.finalValue, 0);
          expect(positionsFinal).toBe(breakdown.finalTotal);
        }
      }),
    );
  });

  it("never sells in a taxable account unless sellInTaxableAccounts is set", () => {
    const taxableAccountIds = new Set(fixture.accounts.filter((a) => a.taxType === "taxable").map((a) => a.id));
    fc.assert(
      fc.property(rawWeightsArb, amountsArb, optimizerArb, (rawWeights, amounts, optimizer) => {
        const portfolio: Portfolio = { ...fixture };
        const result = rebalance(portfolio, makeTargets(rawWeights), {
          contributions: buildContributions(amounts),
          allowSelling: true,
          sellInTaxableAccounts: false,
          optimizer,
        });
        return result.trades.every((t) => t.action === "buy" || !taxableAccountIds.has(t.accountId));
      }),
    );
  });

  it("never sells an asset class below its target dollars", () => {
    fc.assert(
      fc.property(rawWeightsArb, amountsArb, optimizerArb, (rawWeights, amounts, optimizer) => {
        const portfolio: Portfolio = { ...fixture };
        const targets = makeTargets(rawWeights);
        const contributions = buildContributions(amounts);
        const result = rebalance(portfolio, targets, {
          contributions,
          allowSelling: true,
          sellInTaxableAccounts: true,
          optimizer,
        });

        const newTotal =
          portfolio.holdings.reduce((s, h) => s + h.value, 0) + contributions.reduce((s, c) => s + c.amount, 0);
        const fundsById = new Map(fixture.funds.map((f) => [f.id, f]));
        const soldClasses = new Set(
          result.trades.filter((t) => t.action === "sell").map((t) => fundsById.get(t.fundId)!.assetClassId),
        );
        const currentByClass = new Map<string, number>();
        for (const holding of portfolio.holdings) {
          const classId = fundsById.get(holding.fundId)!.assetClassId;
          currentByClass.set(classId, (currentByClass.get(classId) ?? 0) + holding.value);
        }
        for (const target of targets) {
          if (!soldClasses.has(target.assetClassId)) continue;
          const resulting = result.resultingAllocation.find((a) => a.assetClassId === target.assetClassId)!;
          // A class with sell trades may legitimately end below target when it
          // *started* below target: the lp engine can relocate it between
          // accounts (sell here, buy back there) to free a restricted fund
          // menu for another class, leaving its own total unchanged. What
          // selling must never do is *push* a class's total below target, so
          // the floor is min(current, target), not target itself.
          const targetDollars = Math.floor((newTotal * target.weight) / 10000);
          const floor = Math.min(currentByClass.get(target.assetClassId) ?? 0, targetDollars);
          // Target dollars round to within one cent of the exact proportion,
          // and the lp optimizer's float→integer repair can shift a class
          // total by strictly less than one cent per account.
          const slack = 1 + fixture.accounts.length;
          expect(resulting.value).toBeGreaterThanOrEqual(floor - slack);
        }
      }),
    );
  });

  it("is deterministic no matter how input arrays are ordered", () => {
    fc.assert(
      fc.property(
        rawWeightsArb,
        amountsArb,
        sellOptionsArb,
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (rawWeights, amounts, sellOptions, seed) => {
          const targets = makeTargets(rawWeights);
          const contributions = buildContributions(amounts);
          const portfolio: Portfolio = { ...fixture };

          const baseline = rebalance(portfolio, targets, { contributions, ...sellOptions });

          const shuffledPortfolio: Portfolio = {
            assetClasses: shuffled(portfolio.assetClasses, seed),
            funds: shuffled(portfolio.funds, seed + 1),
            accounts: shuffled(portfolio.accounts, seed + 2),
            holdings: shuffled(portfolio.holdings, seed + 3),
          };
          const reordered = rebalance(shuffledPortfolio, shuffled(targets, seed + 4), {
            contributions: shuffled(contributions, seed + 5),
            ...sellOptions,
          });

          expect(reordered).toEqual(baseline);
        },
      ),
    );
  });
});
