import { TOTAL_BPS } from "@rebalancer/solver";
import type { Account, AssetClass, Contribution, Fund, Scenario, TaxType } from "@rebalancer/solver";

/**
 * Pure Scenario -> Scenario updaters for the editor. This is state
 * plumbing only: no money math, no allocation decisions — anything the
 * solver could compute stays in the solver.
 */

/** Set an asset class's target weight (integer bps), adding the entry if missing. */
export function withTargetWeight(scenario: Scenario, assetClassId: string, weight: number): Scenario {
  const exists = scenario.targets.some((t) => t.assetClassId === assetClassId);
  const targets = exists
    ? scenario.targets.map((t) => (t.assetClassId === assetClassId ? { ...t, weight } : t))
    : [...scenario.targets, { assetClassId, weight }];
  return { ...scenario, targets };
}

/** Set an account's contribution (integer cents); 0 removes the entry. */
export function withContribution(scenario: Scenario, accountId: string, amount: number): Scenario {
  const contributions: Contribution[] = scenario.contributions.filter((c) => c.accountId !== accountId);
  if (amount !== 0) contributions.push({ accountId, amount });
  return { ...scenario, contributions };
}

/**
 * Merge an options patch. Keeps the selling flags coherent the same way the
 * CLI does: selling in taxable accounts or optimizing asset location implies
 * selling (both are meaningless without it), and turning selling off turns
 * both dependent flags off with it.
 */
export function withOptions(scenario: Scenario, patch: NonNullable<Scenario["options"]>): Scenario {
  const options = { ...scenario.options, ...patch };
  if (patch.sellInTaxableAccounts || patch.optimizeAssetLocation) options.allowSelling = true;
  if (patch.allowSelling === false) {
    options.sellInTaxableAccounts = false;
    options.optimizeAssetLocation = false;
  }
  return { ...scenario, options };
}

/** Sum of target weights in bps — the "must total 100%" form indicator. */
export function targetWeightTotal(scenario: Scenario): number {
  return scenario.targets.reduce((sum, t) => sum + t.weight, 0);
}

/* ---- Portfolio building ----------------------------------------------- */

/** "US Small-Cap Value" -> "us-small-cap-value", uniquified against taken ids. */
function newId(name: string, taken: Iterable<string>, fallback: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  const existing = new Set(taken);
  if (!existing.has(slug)) return slug;
  for (let n = 2; ; n++) {
    if (!existing.has(`${slug}-${n}`)) return `${slug}-${n}`;
  }
}

function withPortfolio(scenario: Scenario, patch: Partial<Scenario["portfolio"]>): Scenario {
  return { ...scenario, portfolio: { ...scenario.portfolio, ...patch } };
}

export function addAssetClass(scenario: Scenario, name: string): Scenario {
  const id = newId(name, scenario.portfolio.assetClasses.map((c) => c.id), "asset-class");
  return withPortfolio(scenario, {
    assetClasses: [...scenario.portfolio.assetClasses, { id, name }],
  });
}

export function updateAssetClass(
  scenario: Scenario,
  id: string,
  patch: Partial<Omit<AssetClass, "id">>,
): Scenario {
  return withPortfolio(scenario, {
    assetClasses: scenario.portfolio.assetClasses.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  });
}

/**
 * Removing a class removes its slice from every fund's blend (renormalizing
 * the rest so the fund stays valid), removes funds that held nothing else
 * (and their holdings/availability), and drops its target.
 */
export function removeAssetClass(scenario: Scenario, id: string): Scenario {
  let next = withPortfolio(scenario, {
    assetClasses: scenario.portfolio.assetClasses.filter((c) => c.id !== id),
  });
  for (const fund of scenario.portfolio.funds) {
    if (!(id in fund.assetClasses)) continue;
    const remaining = Object.entries(fund.assetClasses).filter(([classId]) => classId !== id);
    if (remaining.length === 0) {
      next = removeFund(next, fund.id);
    } else {
      next = updateFund(next, fund.id, { assetClasses: renormalizedWeights(remaining) });
    }
  }
  return { ...next, targets: next.targets.filter((t) => t.assetClassId !== id) };
}

/**
 * Scale blend weights so they total exactly TOTAL_BPS again (largest
 * remainder, ties by class id; an all-zero blend splits evenly). Structure
 * repair for cascading removals only — no allocation decisions here.
 */
function renormalizedWeights(entries: Array<[string, number]>): Record<string, number> {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total === TOTAL_BPS) return Object.fromEntries(entries);
  const shares = entries.map(([classId, weight]) => {
    const exact = total === 0 ? TOTAL_BPS / entries.length : (TOTAL_BPS * weight) / total;
    const floor = Math.floor(exact);
    return { classId, floor, remainder: exact - floor };
  });
  let remaining = TOTAL_BPS - shares.reduce((sum, s) => sum + s.floor, 0);
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.classId.localeCompare(b.classId));
  for (const share of byRemainder) {
    if (remaining <= 0) break;
    share.floor += 1;
    remaining -= 1;
  }
  return Object.fromEntries(shares.map((s) => [s.classId, s.floor]));
}

export function addFund(scenario: Scenario, ticker: string, assetClassId: string): Scenario {
  const id = newId(ticker, scenario.portfolio.funds.map((f) => f.id), "fund");
  return withPortfolio(scenario, {
    funds: [...scenario.portfolio.funds, { id, ticker, name: "", assetClasses: { [assetClassId]: TOTAL_BPS } }],
  });
}

export function updateFund(scenario: Scenario, id: string, patch: Partial<Omit<Fund, "id">>): Scenario {
  return withPortfolio(scenario, {
    funds: scenario.portfolio.funds.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  });
}

/* ---- Fund blends (assetClassId → bps, summing to TOTAL_BPS) ------------ */

/** Sum of a fund's blend weights in bps — the "must total 100%" indicator for the blend editor. */
export function fundWeightTotal(fund: Fund): number {
  return Object.values(fund.assetClasses).reduce((sum, weight) => sum + weight, 0);
}

/** Collapse a fund to a single asset class at 100%. */
export function setFundSoleClass(scenario: Scenario, fundId: string, assetClassId: string): Scenario {
  return updateFund(scenario, fundId, { assetClasses: { [assetClassId]: TOTAL_BPS } });
}

/** Set one slice's weight (integer bps) in a fund's blend, leaving the other slices alone. */
export function setFundClassWeight(scenario: Scenario, fundId: string, assetClassId: string, weight: number): Scenario {
  const fund = scenario.portfolio.funds.find((f) => f.id === fundId);
  if (!fund) return scenario;
  return updateFund(scenario, fundId, { assetClasses: { ...fund.assetClasses, [assetClassId]: weight } });
}

/** Add a slice for a class, pre-filled with whatever weight is missing from 100%. */
export function addFundClass(scenario: Scenario, fundId: string, assetClassId: string): Scenario {
  const fund = scenario.portfolio.funds.find((f) => f.id === fundId);
  if (!fund || assetClassId in fund.assetClasses) return scenario;
  const missing = Math.max(0, TOTAL_BPS - fundWeightTotal(fund));
  return setFundClassWeight(scenario, fundId, assetClassId, missing);
}

/** Remove a slice; a single surviving slice is bumped to 100% so the fund stays valid. */
export function removeFundClass(scenario: Scenario, fundId: string, assetClassId: string): Scenario {
  const fund = scenario.portfolio.funds.find((f) => f.id === fundId);
  if (!fund) return scenario;
  const remaining = Object.entries(fund.assetClasses).filter(([classId]) => classId !== assetClassId);
  if (remaining.length === 0) return scenario; // never leave a fund classless
  const assetClasses =
    remaining.length === 1
      ? { [remaining[0]![0]]: TOTAL_BPS }
      : Object.fromEntries(remaining);
  return updateFund(scenario, fundId, { assetClasses });
}

/** Point a slice at a different class, keeping its weight and position (merges if the target exists). */
export function replaceFundClass(scenario: Scenario, fundId: string, fromClassId: string, toClassId: string): Scenario {
  const fund = scenario.portfolio.funds.find((f) => f.id === fundId);
  if (!fund || !(fromClassId in fund.assetClasses) || fromClassId === toClassId) return scenario;
  const assetClasses: Record<string, number> = {};
  for (const [classId, weight] of Object.entries(fund.assetClasses)) {
    const key = classId === fromClassId ? toClassId : classId;
    assetClasses[key] = (assetClasses[key] ?? 0) + weight;
  }
  return updateFund(scenario, fundId, { assetClasses });
}

/** Removing a fund removes its holdings and pulls it from every account's menu. */
export function removeFund(scenario: Scenario, id: string): Scenario {
  return withPortfolio(scenario, {
    funds: scenario.portfolio.funds.filter((f) => f.id !== id),
    holdings: scenario.portfolio.holdings.filter((h) => h.fundId !== id),
    accounts: scenario.portfolio.accounts.map((a) =>
      a.availableFundIds.includes(id)
        ? { ...a, availableFundIds: a.availableFundIds.filter((fundId) => fundId !== id) }
        : a,
    ),
  });
}

export function addAccount(scenario: Scenario, name: string, taxType: TaxType): Scenario {
  const id = newId(name, scenario.portfolio.accounts.map((a) => a.id), "account");
  return withPortfolio(scenario, {
    accounts: [...scenario.portfolio.accounts, { id, name, taxType, availableFundIds: [] }],
  });
}

export function updateAccount(
  scenario: Scenario,
  id: string,
  patch: Partial<Omit<Account, "id" | "availableFundIds">>,
): Scenario {
  return withPortfolio(scenario, {
    accounts: scenario.portfolio.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  });
}

/** Removing an account removes its holdings and its contribution. */
export function removeAccount(scenario: Scenario, id: string): Scenario {
  return {
    ...withPortfolio(scenario, {
      accounts: scenario.portfolio.accounts.filter((a) => a.id !== id),
      holdings: scenario.portfolio.holdings.filter((h) => h.accountId !== id),
    }),
    contributions: scenario.contributions.filter((c) => c.accountId !== id),
  };
}

/** Make a fund buyable (appended least-preferred) or not buyable in an account. */
export function setFundAvailability(
  scenario: Scenario,
  accountId: string,
  fundId: string,
  available: boolean,
): Scenario {
  return withPortfolio(scenario, {
    accounts: scenario.portfolio.accounts.map((a) => {
      if (a.id !== accountId) return a;
      const without = a.availableFundIds.filter((f) => f !== fundId);
      return { ...a, availableFundIds: available ? [...without, fundId] : without };
    }),
  });
}

/** Move a fund to a new position in an account's preference order (0 = most preferred). */
export function reorderFundPreference(scenario: Scenario, accountId: string, fundId: string, toIndex: number): Scenario {
  return withPortfolio(scenario, {
    accounts: scenario.portfolio.accounts.map((a) => {
      if (a.id !== accountId) return a;
      const fromIndex = a.availableFundIds.indexOf(fundId);
      if (fromIndex === -1) return a;
      const clamped = Math.max(0, Math.min(a.availableFundIds.length - 1, toIndex));
      if (clamped === fromIndex) return a;
      const reordered = [...a.availableFundIds];
      reordered.splice(fromIndex, 1);
      reordered.splice(clamped, 0, fundId);
      return { ...a, availableFundIds: reordered };
    }),
  });
}

/** Set a position's current value (integer cents); 0 removes the holding. */
export function withHolding(scenario: Scenario, accountId: string, fundId: string, value: number): Scenario {
  const holdings = scenario.portfolio.holdings.filter((h) => !(h.accountId === accountId && h.fundId === fundId));
  if (value !== 0) holdings.push({ accountId, fundId, value });
  return withPortfolio(scenario, { holdings });
}

/**
 * A blank slate for building a portfolio from scratch. Selling is on by
 * default in the web UI (the solver's own default stays buy-only), but
 * never in taxable accounts until the user opts in via ⚙ Settings; the
 * note beside the Trades heading always states the selling posture.
 */
export function emptyScenario(): Scenario {
  return {
    portfolio: { accounts: [], funds: [], assetClasses: [], holdings: [] },
    targets: [],
    contributions: [],
    options: { allowSelling: true, sellInTaxableAccounts: false },
  };
}
