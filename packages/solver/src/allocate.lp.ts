import { solve } from "yalps";
import type { Constraint, Model } from "yalps";
import { isTaxAdvantaged, taxTypeRank } from "./allocate.ts";
import type { Allocation, AllocationWarning, ProblemAccount, ProblemAssetClass, TransportationProblem } from "./allocate.ts";

/**
 * LP-backed allocate(): the drop-in alternative to the greedy waterfall,
 * behind the same TransportationProblem seam. Solves the placement as a
 * linear program (YALPS — pure JS, synchronous, no I/O) with a
 * lexicographic objective, each stage pinned as a constraint before the
 * next runs:
 *
 *   1. minimize total deviation beyond the tolerance band,
 *   2. minimize total dollars sold (never churn more than needed),
 *   3. minimize dollars sold in taxable accounts,
 *   4. maximize dollars placed in tax-preferred accounts.
 *
 * Hard constraints: each account's total is fixed (money never leaves an
 * account), non-buyable positions can't grow, sells respect the caller's
 * caps, and no asset class's total may drop below min(current, target) —
 * the same never-sell-below-target guarantee the greedy pass makes.
 *
 * The tolerance band works exactly like the greedy allocator's: it is an
 * *eligibility* test on the inputs, not a stopping zone. A class whose
 * initial drift exceeds the band is penalized against its exact target
 * (fix fully); a class already within the band is frozen against selling
 * and carries no penalty (never churned, but free to absorb surplus cash).
 *
 * minTradeCents is honored by iterative refinement (a "0 or ≥ threshold"
 * sell is not expressible in a single LP): solve, ban selling any position
 * whose sell came out below the floor, re-solve; repeat until every sell
 * clears the floor or doesn't happen — the same semantics as the greedy
 * sell pass. Terminates in at most one solve per sellable position.
 *
 * The simplex works in floats; positions the solver left (near-)untouched
 * are snapped back to exactly their current value — so rounding noise never
 * fabricates a one-cent trade — and a per-account largest-remainder repair
 * rounds the rest to integer cents, exactly conserving every account
 * total. Unlike the greedy allocator, leftover cash is placed wherever the
 * objective likes best (never emitting a leftover_cash warning), and
 * equally-optimal placements may differ from the greedy waterfall's.
 *
 * Determinism: the model is built in sorted id order and YALPS's simplex is
 * deterministic, so shuffled inputs produce the identical model and result.
 */

/**
 * All true quantities are integer cents, but the simplex returns floats: a
 * value within half a cent of an integer can only mean that integer, so a
 * float difference below this threshold can never be a real cent of
 * trading. Used to decide what counts as "actually sold" and what snaps
 * back to its current value.
 */
const HALF_CENT = 0.5;

/**
 * Added inside Math.floor() so accumulated float error just *below* an
 * integer (e.g. 4.9999997 for a true 5) floors to the intended value.
 * Must stay far smaller than HALF_CENT so it can never flip a genuine
 * fractional part up to the next cent.
 */
const FLOOR_GUARD = 1e-6;

/** Absolute slack on lexicographic pins, generous for float noise at cent scale. */
const PIN_EPSILON = 1e-3;

/** Relative slack on lexicographic pins, for objectives at large dollar magnitudes. */
const PIN_RELATIVE = 1e-9;

export function allocateLp(problem: TransportationProblem): Allocation {
  const accounts = [...problem.accounts].sort((a, b) => a.id.localeCompare(b.id));
  const assetClasses = [...problem.assetClasses].sort((a, b) => a.id.localeCompare(b.id));

  const held = (accountId: string, assetClassId: string): number =>
    problem.current.get(accountId)?.get(assetClassId) ?? 0;

  // Iterative refinement for minTradeCents: any position whose sell comes
  // out positive but below the floor gets selling banned outright, and the
  // program is re-solved. Each pass bans at least one position, so this
  // ends within one solve per sellable position.
  const bannedSells = new Set<string>();
  let finalValues: Map<string, number>;
  for (;;) {
    finalValues = solveLexicographic(problem, accounts, assetClasses, bannedSells);
    if (problem.minTradeCents <= 0) break;
    let bannedThisPass = false;
    for (const account of accounts) {
      for (const assetClass of assetClasses) {
        const key = `${account.id} ${assetClass.id}`;
        if (bannedSells.has(key)) continue;
        const sold = held(account.id, assetClass.id) - (finalValues.get(`x ${key}`) ?? 0);
        if (sold > HALF_CENT && sold < problem.minTradeCents - HALF_CENT) {
          bannedSells.add(key);
          bannedThisPass = true;
        }
      }
    }
    if (!bannedThisPass) break;
  }

  // Round the float solution back to integer cents. Positions the solver
  // left (near-)untouched snap to exactly their current value; the rest are
  // rounded largest-remainder-first, then nudged within their bounds until
  // each account's total is conserved exactly.
  const x = new Map<string, Map<string, number>>();
  for (const account of accounts) {
    let target = problem.cash.get(account.id) ?? 0;
    for (const assetClass of assetClasses) target += held(account.id, assetClass.id);

    const cells = assetClasses
      .filter((assetClass) => finalValues.has(`x ${account.id} ${assetClass.id}`) || held(account.id, assetClass.id) > 0)
      .map((assetClass) => {
        const current = held(account.id, assetClass.id);
        const raw = Math.max(0, finalValues.get(`x ${account.id} ${assetClass.id}`) ?? current);
        const snapped = Math.abs(raw - current) < HALF_CENT;
        const value = snapped ? current : Math.floor(raw + FLOOR_GUARD);
        const sellCap = bannedSells.has(`${account.id} ${assetClass.id}`)
          ? 0
          : Math.max(0, Math.min(current, problem.sellable(account.id, assetClass.id)));
        return {
          assetClassId: assetClass.id,
          value,
          remainder: snapped ? -1 : raw - value,
          snapped,
          lowerBound: current - sellCap,
          upperBound: problem.buyable(account.id, assetClass.id) ? Number.MAX_SAFE_INTEGER : current,
        };
      });

    let leftover = target - cells.reduce((sum, cell) => sum + cell.value, 0);
    // Prefer adjusting genuinely-traded cells (largest remainder first when
    // adding, smallest first when removing); snapped cells only as a last
    // resort so noise never fabricates a trade.
    const addOrder = [...cells].sort(
      (a, b) => Number(a.snapped) - Number(b.snapped) || b.remainder - a.remainder || a.assetClassId.localeCompare(b.assetClassId),
    );
    const removeOrder = [...cells].sort(
      (a, b) => Number(a.snapped) - Number(b.snapped) || a.remainder - b.remainder || a.assetClassId.localeCompare(b.assetClassId),
    );
    while (leftover !== 0) {
      const order = leftover > 0 ? addOrder : removeOrder;
      let progressed = false;
      for (const cell of order) {
        if (leftover === 0) break;
        if (leftover > 0 && cell.value < cell.upperBound) {
          cell.value += 1;
          leftover -= 1;
          progressed = true;
        } else if (leftover < 0 && cell.value > Math.max(0, cell.lowerBound)) {
          cell.value -= 1;
          leftover += 1;
          progressed = true;
        }
      }
      if (!progressed) {
        throw new Error(`LP rounding failed to conserve account "${account.id}" by ${leftover} cents.`);
      }
    }

    const row = new Map<string, number>();
    for (const cell of cells) {
      if (cell.value !== 0 || held(account.id, cell.assetClassId) !== 0) row.set(cell.assetClassId, cell.value);
    }
    x.set(account.id, row);
  }

  // Same warning contract as the greedy allocator: gaps beyond the band
  // that survived, largest first. (leftover_cash never applies here — the
  // objective, not a fallback rule, decides where surplus cash lands.)
  const warnings: AllocationWarning[] = [];
  const unreachable = assetClasses
    .map((assetClass) => {
      let total = 0;
      for (const account of accounts) total += x.get(account.id)!.get(assetClass.id) ?? 0;
      return { assetClassId: assetClass.id, remainingGap: (problem.demands.get(assetClass.id) ?? 0) - total };
    })
    .filter((entry) => entry.remainingGap > problem.toleranceCents)
    .sort((a, b) => b.remainingGap - a.remainingGap || a.assetClassId.localeCompare(b.assetClassId));
  for (const { assetClassId, remainingGap } of unreachable) {
    warnings.push({ kind: "unreachable_gap", assetClassId, remainingGap });
  }

  return { x, warnings };
}

/** Builds the model (with the given positions banned from selling) and runs the four pinned stages. */
function solveLexicographic(
  problem: TransportationProblem,
  accounts: ProblemAccount[],
  assetClasses: ProblemAssetClass[],
  bannedSells: Set<string>,
): Map<string, number> {
  const held = (accountId: string, assetClassId: string): number =>
    problem.current.get(accountId)?.get(assetClassId) ?? 0;
  const demand = (assetClassId: string): number => problem.demands.get(assetClassId) ?? 0;

  const constraints = new Map<string, Constraint>();
  const variables = new Map<string, Map<string, number>>();
  let hasSells = false;
  let hasPreferences = false;

  // Band as eligibility, computed from the inputs (mirrors the greedy
  // allocator): a class drifted beyond the band is "active" and penalized
  // against its exact target; a class within the band is left alone —
  // no penalty, but its total may never shrink.
  const active = new Map<string, boolean>();
  for (const assetClass of assetClasses) {
    let currentTotal = 0;
    for (const account of accounts) currentTotal += held(account.id, assetClass.id);
    active.set(assetClass.id, Math.abs(currentTotal - demand(assetClass.id)) > problem.toleranceCents);
  }

  // x variables: final cents per (account, class) the account can hold.
  for (const account of accounts) {
    let total = problem.cash.get(account.id) ?? 0;
    for (const assetClass of assetClasses) total += held(account.id, assetClass.id);
    constraints.set(`acct ${account.id}`, { equal: total });

    for (const assetClass of assetClasses) {
      const current = held(account.id, assetClass.id);
      const buyable = problem.buyable(account.id, assetClass.id);
      if (current === 0 && !buyable) continue; // x is identically zero

      const coefficients = new Map<string, number>();
      coefficients.set(`acct ${account.id}`, 1);
      if (active.get(assetClass.id)) {
        coefficients.set(`devhi ${assetClass.id}`, 1);
        coefficients.set(`devlo ${assetClass.id}`, 1);
      }
      coefficients.set(`floor ${assetClass.id}`, 1);
      if (!buyable) {
        constraints.set(`ub ${account.id} ${assetClass.id}`, { max: current });
        coefficients.set(`ub ${account.id} ${assetClass.id}`, 1);
      }
      const sellCap = bannedSells.has(`${account.id} ${assetClass.id}`)
        ? 0
        : Math.max(0, Math.min(current, problem.sellable(account.id, assetClass.id)));
      if (current - sellCap > 0) {
        constraints.set(`lb ${account.id} ${assetClass.id}`, { min: current - sellCap });
        coefficients.set(`lb ${account.id} ${assetClass.id}`, 1);
      }
      if (sellCap > 0) {
        // s >= current − x measures dollars sold out of this position.
        hasSells = true;
        constraints.set(`sold ${account.id} ${assetClass.id}`, { min: current });
        coefficients.set(`sold ${account.id} ${assetClass.id}`, 1);
        const slack = new Map<string, number>();
        slack.set(`sold ${account.id} ${assetClass.id}`, 1);
        slack.set("sells", 1);
        if (!isTaxAdvantaged(account.taxType)) slack.set("taxsells", 1);
        variables.set(`s ${account.id} ${assetClass.id}`, slack);
      }
      if (assetClass.taxPreference !== "neutral" && taxTypeRank(assetClass.taxPreference, account.taxType) === 0) {
        hasPreferences = true;
        coefficients.set("pref", 1);
      }
      variables.set(`x ${account.id} ${assetClass.id}`, coefficients);
    }
  }

  // Class-level constraints: active classes get deviation slacks measured
  // from the exact target; within-band classes just may never shrink.
  for (const assetClass of assetClasses) {
    let currentTotal = 0;
    for (const account of accounts) currentTotal += held(account.id, assetClass.id);
    if (active.get(assetClass.id)) {
      constraints.set(`devhi ${assetClass.id}`, { max: demand(assetClass.id) });
      constraints.set(`devlo ${assetClass.id}`, { min: demand(assetClass.id) });
      constraints.set(`floor ${assetClass.id}`, { min: Math.min(currentTotal, demand(assetClass.id)) });
      variables.set(`over ${assetClass.id}`, new Map([[`devhi ${assetClass.id}`, -1], ["dev", 1]]));
      variables.set(`under ${assetClass.id}`, new Map([[`devlo ${assetClass.id}`, 1], ["dev", 1]]));
    } else {
      constraints.set(`floor ${assetClass.id}`, { min: currentTotal });
    }
  }

  // Lexicographic solve: optimize each stage, then pin it before the next.
  const stages: Array<{ objective: string; direction: "minimize" | "maximize"; active: boolean }> = [
    { objective: "dev", direction: "minimize", active: true },
    { objective: "sells", direction: "minimize", active: hasSells },
    { objective: "taxsells", direction: "minimize", active: hasSells },
    { objective: "pref", direction: "maximize", active: hasPreferences },
  ];

  let finalValues = new Map<string, number>();
  for (const stage of stages) {
    if (!stage.active) continue;
    const model: Model = { direction: stage.direction, objective: stage.objective, constraints, variables };
    const solution = solve(model, { includeZeroVariables: true });
    if (solution.status !== "optimal") {
      throw new Error(`LP allocation failed at stage "${stage.objective}": ${solution.status}.`);
    }
    const pin = Math.abs(solution.result) * PIN_RELATIVE + PIN_EPSILON;
    constraints.set(
      stage.objective,
      stage.direction === "minimize" ? { max: solution.result + pin } : { min: solution.result - pin },
    );
    finalValues = new Map(solution.variables);
  }
  return finalValues;
}
