import { solve } from "yalps";
import type { Constraint, Model } from "yalps";
import { isTaxAdvantaged, taxTypeRank } from "./allocate.ts";
import type {
  Allocation,
  AllocationWarning,
  ProblemAccount,
  ProblemFund,
  TransportationProblem,
} from "./allocate.ts";
import { TOTAL_BPS } from "./types.ts";

/**
 * The allocator: an LP behind the TransportationProblem seam defined in
 * allocate.ts. The decision variables
 * are the final cents per (account × fund) — not per asset class — so a
 * blended fund (VT = 65% US + 35% intl) is handled natively: buying or
 * selling it moves every component in lockstep, and each asset class's
 * exposure is the weight-scaled sum over every fund that contains it.
 * Solved as a linear program (YALPS — pure JS, synchronous, no I/O) with a
 * lexicographic objective, each stage pinned as a constraint before the
 * next runs:
 *
 *   1. minimize total class deviation beyond the tolerance band,
 *   2. minimize total dollars sold (never churn more than needed),
 *   3. minimize dollars sold in taxable accounts,
 *   4. maximize dollars placed in tax-preferred accounts,
 *   5. steer residual freedom by fund preference (buys go to an account's
 *      earliest availableFundIds entry, sells drain the latest — with sells
 *      already pinned minimal, this stage can only pick *which* fund, never
 *      add churn).
 *
 * Because stage 4 outranks stage 5, *surplus* contribution cash (cash whose
 * account offers no fund for any remaining gap) is parked in a tax-preferred
 * class when the account has one, and menu order only picks the fund within
 * that class. Deliberate asset-location behavior — but it is a policy the
 * user currently has no way to override (e.g. "my menu order wins", or
 * "leave surplus as uninvested cash / contributions-to-deploy"; cash is not
 * a modeled position today). If that comes up, add an option rather than
 * reordering the stages — see the "surplus contribution cash policy" issue.
 *
 * Hard constraints: each account's total is fixed (money never leaves an
 * account), non-buyable positions can't grow, sells respect the caller's
 * caps, and no asset class's total may drop below min(current, target) —
 * the never-sell-below-target guarantee. For a
 * blended fund that floor binds the *class* exposure, so selling a blend is
 * allowed exactly when every component stays above its own floor.
 *
 * The tolerance band is an
 * *eligibility* test on the inputs, not a stopping zone. A class whose
 * initial drift exceeds the band is penalized against its exact target
 * (fix fully); a class already within the band is frozen against selling
 * and carries no penalty (never churned, but free to absorb surplus cash).
 * Class drift is measured exactly, in integer cent-basis-points, before any
 * float enters the picture.
 *
 * minTradeCents is honored by iterative refinement (a "0 or ≥ threshold"
 * sell is not expressible in a single LP): solve, ban selling any position
 * whose sell came out below the floor, re-solve; repeat until every sell
 * clears the floor or doesn't happen. Terminates in at most one solve per
 * sellable position.
 *
 * The simplex works in floats; positions the solver left (near-)untouched
 * are snapped back to exactly their current value — so rounding noise never
 * fabricates a one-cent trade — and a per-account largest-remainder repair
 * rounds the rest to integer cents, exactly conserving every account
 * total. Class totals can carry < 1 cent of noise per position, which the
 * property tests carry as explicit slack.
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

/**
 * Collision-proof (account, fund) pair key for model constraint/variable
 * names and the banned-sells set. Ids are arbitrary user strings — they may
 * contain the very space a naive `${a} ${f}` join would use, and account
 * "a" + fund "b f" must never alias account "a b" + fund "f".
 */
const cellKey = (accountId: string, fundId: string): string => JSON.stringify([accountId, fundId]);

/**
 * Subtracted from class-floor constraints. A blend's class exposure is
 * Σ x·(weight/TOTAL_BPS) in floats, which can land a whisper below the
 * exactly-computed integer floor even for the do-nothing solution; the
 * absolute part is a thousandth of a cent and the relative part tracks how
 * float error actually grows with position size, so together they stay far
 * too small to admit a real trade anywhere under rebalance()'s portfolio
 * cap (at the ~$9B cap the combined slack is still under a cent).
 */
const FLOOR_EPSILON = 1e-3;

/** Relative component of the class-floor slack (see FLOOR_EPSILON). */
const FLOOR_RELATIVE = 1e-12;

/** The class floor `value`, slackened for float noise: min ≥ value − (abs + rel·value). */
const slackenedFloor = (value: number): number => value - (FLOOR_EPSILON + value * FLOOR_RELATIVE);

export function allocateLp(problem: TransportationProblem): Allocation {
  const accounts = [...problem.accounts].sort((a, b) => a.id.localeCompare(b.id));
  const funds = [...problem.funds].sort((a, b) => a.id.localeCompare(b.id));

  const held = (accountId: string, fundId: string): number => problem.current.get(accountId)?.get(fundId) ?? 0;

  // Iterative refinement for minTradeCents: any position whose sell comes
  // out positive but below the floor gets selling banned outright, and the
  // program is re-solved. Each pass bans at least one position, so this
  // ends within one solve per sellable position.
  const bannedSells = new Set<string>();
  let finalValues: Map<string, number>;
  for (;;) {
    finalValues = solveLexicographic(problem, accounts, funds, bannedSells);
    if (problem.minTradeCents <= 0) break;
    let bannedThisPass = false;
    for (const account of accounts) {
      for (const fund of funds) {
        const key = cellKey(account.id, fund.id);
        if (bannedSells.has(key)) continue;
        const sold = held(account.id, fund.id) - (finalValues.get(`x ${key}`) ?? 0);
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
    for (const fund of funds) target += held(account.id, fund.id);

    const cells = funds
      .filter((fund) => finalValues.has(`x ${cellKey(account.id, fund.id)}`) || held(account.id, fund.id) > 0)
      .map((fund) => {
        const current = held(account.id, fund.id);
        const raw = Math.max(0, finalValues.get(`x ${cellKey(account.id, fund.id)}`) ?? current);
        const snapped = Math.abs(raw - current) < HALF_CENT;
        const value = snapped ? current : Math.floor(raw + FLOOR_GUARD);
        const sellCap = bannedSells.has(cellKey(account.id, fund.id))
          ? 0
          : Math.max(0, Math.min(current, problem.sellable(account.id, fund.id)));
        return {
          fundId: fund.id,
          value,
          remainder: snapped ? -1 : raw - value,
          snapped,
          lowerBound: current - sellCap,
          upperBound: problem.buyable(account.id, fund.id) ? Number.MAX_SAFE_INTEGER : current,
        };
      });

    let leftover = target - cells.reduce((sum, cell) => sum + cell.value, 0);
    // Prefer adjusting genuinely-traded cells (largest remainder first when
    // adding, smallest first when removing); snapped cells only as a last
    // resort so noise never fabricates a trade.
    const addOrder = [...cells].sort(
      (a, b) => Number(a.snapped) - Number(b.snapped) || b.remainder - a.remainder || a.fundId.localeCompare(b.fundId),
    );
    const removeOrder = [...cells].sort(
      (a, b) => Number(a.snapped) - Number(b.snapped) || a.remainder - b.remainder || a.fundId.localeCompare(b.fundId),
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
      if (cell.value !== 0 || held(account.id, cell.fundId) !== 0) row.set(cell.fundId, cell.value);
    }
    x.set(account.id, row);
  }

  // Warnings: gaps beyond the band that survived, largest first. Class
  // exposure is computed exactly in integer cent-basis-points from the
  // rounded fund values. (Surplus cash never warrants one — the objective
  // decides where it lands, ultimately the most-preferred funds.)
  const finalCentBps = new Map<string, number>();
  for (const assetClass of problem.assetClasses) finalCentBps.set(assetClass.id, 0);
  for (const account of accounts) {
    for (const fund of funds) {
      const value = x.get(account.id)!.get(fund.id) ?? 0;
      if (value === 0) continue;
      for (const [classId, weight] of fund.weights) {
        finalCentBps.set(classId, (finalCentBps.get(classId) ?? 0) + value * weight);
      }
    }
  }
  const warnings: AllocationWarning[] = [];
  const unreachable = [...problem.assetClasses]
    .map((assetClass) => {
      const gapCentBps = (problem.demands.get(assetClass.id) ?? 0) * TOTAL_BPS - (finalCentBps.get(assetClass.id) ?? 0);
      return { assetClassId: assetClass.id, gapCentBps };
    })
    .filter((entry) => entry.gapCentBps > problem.toleranceCents * TOTAL_BPS)
    .sort((a, b) => b.gapCentBps - a.gapCentBps || a.assetClassId.localeCompare(b.assetClassId));
  for (const { assetClassId, gapCentBps } of unreachable) {
    warnings.push({ kind: "unreachable_gap", assetClassId, remainingGap: Math.round(gapCentBps / TOTAL_BPS) });
  }

  return { x, warnings };
}

/** Builds the model (with the given positions banned from selling) and runs the five pinned stages. */
function solveLexicographic(
  problem: TransportationProblem,
  accounts: ProblemAccount[],
  funds: ProblemFund[],
  bannedSells: Set<string>,
): Map<string, number> {
  const held = (accountId: string, fundId: string): number => problem.current.get(accountId)?.get(fundId) ?? 0;
  const demand = (assetClassId: string): number => problem.demands.get(assetClassId) ?? 0;
  const assetClasses = [...problem.assetClasses].sort((a, b) => a.id.localeCompare(b.id));
  const taxPreferenceByClass = new Map(assetClasses.map((c) => [c.id, c.taxPreference]));

  const constraints = new Map<string, Constraint>();
  const variables = new Map<string, Map<string, number>>();
  let hasSells = false;
  let hasPreferences = false;
  let hasFundPreferences = false;

  // Band as eligibility, computed from the inputs: a class drifted
  // beyond the band is "active" and penalized
  // against its exact target; a class within the band is left alone —
  // no penalty, but its total may never shrink. Exposures are exact
  // integers in cent-basis-points (cents × weight), so the test never
  // depends on float noise.
  const currentCentBps = new Map<string, number>();
  for (const assetClass of assetClasses) currentCentBps.set(assetClass.id, 0);
  for (const account of accounts) {
    for (const fund of funds) {
      const value = held(account.id, fund.id);
      if (value === 0) continue;
      for (const [classId, weight] of fund.weights) {
        currentCentBps.set(classId, (currentCentBps.get(classId) ?? 0) + value * weight);
      }
    }
  }
  const active = new Map<string, boolean>();
  for (const assetClass of assetClasses) {
    const driftCentBps = Math.abs((currentCentBps.get(assetClass.id) ?? 0) - demand(assetClass.id) * TOTAL_BPS);
    active.set(assetClass.id, driftCentBps > problem.toleranceCents * TOTAL_BPS);
  }

  // x variables: final cents per (account, fund) the account can hold. Every
  // class-level constraint sees the variable through the fund's weights.
  for (const account of accounts) {
    let total = problem.cash.get(account.id) ?? 0;
    for (const fund of funds) total += held(account.id, fund.id);
    constraints.set(`acct ${account.id}`, { equal: total });

    for (const fund of funds) {
      const current = held(account.id, fund.id);
      const buyable = problem.buyable(account.id, fund.id);
      if (current === 0 && !buyable) continue; // x is identically zero

      const coefficients = new Map<string, number>();
      coefficients.set(`acct ${account.id}`, 1);
      let preferredFraction = 0;
      for (const [classId, weight] of fund.weights) {
        const fraction = weight / TOTAL_BPS;
        if (active.get(classId)) {
          coefficients.set(`devhi ${classId}`, fraction);
          coefficients.set(`devlo ${classId}`, fraction);
        }
        coefficients.set(`floor ${classId}`, fraction);
        const preference = taxPreferenceByClass.get(classId) ?? "neutral";
        if (preference !== "neutral" && taxTypeRank(preference, account.taxType) === 0) {
          preferredFraction += fraction;
        }
      }
      if (!buyable) {
        constraints.set(`ub ${cellKey(account.id, fund.id)}`, { max: current });
        coefficients.set(`ub ${cellKey(account.id, fund.id)}`, 1);
      }
      const sellCap = bannedSells.has(cellKey(account.id, fund.id))
        ? 0
        : Math.max(0, Math.min(current, problem.sellable(account.id, fund.id)));
      if (current - sellCap > 0) {
        constraints.set(`lb ${cellKey(account.id, fund.id)}`, { min: current - sellCap });
        coefficients.set(`lb ${cellKey(account.id, fund.id)}`, 1);
      }
      if (sellCap > 0) {
        // s >= current − x measures dollars sold out of this position.
        hasSells = true;
        constraints.set(`sold ${cellKey(account.id, fund.id)}`, { min: current });
        coefficients.set(`sold ${cellKey(account.id, fund.id)}`, 1);
        const slack = new Map<string, number>();
        slack.set(`sold ${cellKey(account.id, fund.id)}`, 1);
        slack.set("sells", 1);
        if (!isTaxAdvantaged(account.taxType)) slack.set("taxsells", 1);
        variables.set(`s ${cellKey(account.id, fund.id)}`, slack);
      }
      if (preferredFraction > 0) {
        hasPreferences = true;
        coefficients.set("pref", preferredFraction);
      }
      const rank = problem.preferenceRank(account.id, fund.id);
      if (rank > 0) {
        hasFundPreferences = true;
        coefficients.set("fundpref", rank);
      }
      variables.set(`x ${cellKey(account.id, fund.id)}`, coefficients);
    }
  }

  // Class-level constraints: active classes get deviation slacks measured
  // from the exact target; within-band classes just may never shrink. The
  // FLOOR_EPSILON keeps float summation of weight fractions from declaring
  // the do-nothing solution infeasible by a millionth of a cent.
  for (const assetClass of assetClasses) {
    const currentCents = (currentCentBps.get(assetClass.id) ?? 0) / TOTAL_BPS;
    if (active.get(assetClass.id)) {
      constraints.set(`devhi ${assetClass.id}`, { max: demand(assetClass.id) });
      constraints.set(`devlo ${assetClass.id}`, { min: demand(assetClass.id) });
      constraints.set(`floor ${assetClass.id}`, {
        min: slackenedFloor(Math.min(currentCents, demand(assetClass.id))),
      });
      variables.set(`over ${assetClass.id}`, new Map([[`devhi ${assetClass.id}`, -1], ["dev", 1]]));
      variables.set(`under ${assetClass.id}`, new Map([[`devlo ${assetClass.id}`, 1], ["dev", 1]]));
    } else {
      constraints.set(`floor ${assetClass.id}`, { min: slackenedFloor(currentCents) });
    }
  }

  // Lexicographic solve: optimize each stage, then pin it before the next.
  const stages: Array<{ objective: string; direction: "minimize" | "maximize"; active: boolean }> = [
    { objective: "dev", direction: "minimize", active: true },
    { objective: "sells", direction: "minimize", active: hasSells },
    { objective: "taxsells", direction: "minimize", active: hasSells },
    { objective: "pref", direction: "maximize", active: hasPreferences },
    { objective: "fundpref", direction: "minimize", active: hasFundPreferences },
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
