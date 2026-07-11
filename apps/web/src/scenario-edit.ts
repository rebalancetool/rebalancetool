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
 * CLI does: selling in taxable accounts implies selling, and turning selling
 * off turns the taxable flag off with it.
 */
export function withOptions(scenario: Scenario, patch: NonNullable<Scenario["options"]>): Scenario {
  const options = { ...scenario.options, ...patch };
  if (patch.sellInTaxableAccounts) options.allowSelling = true;
  if (patch.allowSelling === false) options.sellInTaxableAccounts = false;
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

/** Removing a class removes its funds (and their holdings/availability) and its target. */
export function removeAssetClass(scenario: Scenario, id: string): Scenario {
  let next = withPortfolio(scenario, {
    assetClasses: scenario.portfolio.assetClasses.filter((c) => c.id !== id),
  });
  for (const fund of scenario.portfolio.funds) {
    if (fund.assetClassId === id) next = removeFund(next, fund.id);
  }
  return { ...next, targets: next.targets.filter((t) => t.assetClassId !== id) };
}

export function addFund(scenario: Scenario, ticker: string, assetClassId: string): Scenario {
  const id = newId(ticker, scenario.portfolio.funds.map((f) => f.id), "fund");
  return withPortfolio(scenario, {
    funds: [...scenario.portfolio.funds, { id, ticker, name: "", assetClassId }],
  });
}

export function updateFund(scenario: Scenario, id: string, patch: Partial<Omit<Fund, "id">>): Scenario {
  return withPortfolio(scenario, {
    funds: scenario.portfolio.funds.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  });
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
 * default in the web UI, taxable accounts included (the solver's own
 * default stays buy-only); the always-visible checkbox turns taxable
 * sells off.
 */
export function emptyScenario(): Scenario {
  return {
    portfolio: { accounts: [], funds: [], assetClasses: [], holdings: [] },
    targets: [],
    contributions: [],
    options: { allowSelling: true, sellInTaxableAccounts: true },
  };
}
