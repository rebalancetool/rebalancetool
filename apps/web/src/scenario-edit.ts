import type { Contribution, Scenario } from "@rebalancer/solver";

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
