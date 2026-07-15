import { allocateLp } from "./allocate.lp.ts";
import { taxTypeRank } from "./allocate.ts";
import type { TransportationProblem } from "./allocate.ts";
import { DEFAULT_TOLERANCE_BPS, TOTAL_BPS } from "./types.ts";
import type {
  Account,
  AllocationEntry,
  DeviationEntry,
  Portfolio,
  RebalanceOptions,
  RebalanceResult,
  Target,
  TaxPreference,
  Trade,
} from "./types.ts";

/**
 * Orchestration around the LP allocator (see allocate.lp.ts for the
 * optimization itself).
 *
 * By default (allowSelling: false) this solver only ever recommends
 * purchases. It cannot then force a portfolio to exactly match its targets
 * in one pass — it can only spend new contribution cash to move the
 * portfolio *toward* target; given enough contributions over time, repeated
 * runs converge. With allowSelling: true, it additionally sells overweight
 * positions to fund underweight classes *within the same account* (cash
 * raised by a sell never leaves its account), never selling a class below
 * its portfolio-level target, preferring sells in tax-advantaged accounts,
 * and never touching taxable positions unless sellInTaxableAccounts is also
 * set. With optimizeAssetLocation additionally set, asset-class
 * taxPreference is promoted from a tie-break to an objective: the solver
 * relocates a class between accounts (selling it where it is dispreferred,
 * buying it back where preferred) even when the allocation is already on
 * target — never at the allocation's expense, and still subject to both
 * selling guards above. Everything is governed by the tolerance band (toleranceBps, default
 * 50): a class within ±band of its target weight is treated as on-target —
 * not bought toward, not sold down, not warned about — so trivial drift
 * never triggers trades. Contributions are always fully invested: cash may
 * not sit idle in an account, so surplus beyond every reachable gap is
 * still placed — by asset-class taxPreference first, then by the account's
 * fund preference order (see the stage notes atop allocate.lp.ts).
 *
 * The steps here are bookkeeping, not decisions:
 *
 *   1. Sum current holdings per (account × fund); contributions per account
 *      (each earmarked to one account — money never moves between accounts,
 *      mirroring the real-world constraint that you can't deposit a 401k
 *      payroll contribution into an IRA).
 *   2. Compute each asset class's target dollars at the post-contribution
 *      portfolio total (largest-remainder rounding so targets sum exactly
 *      to that total despite integer-cent truncation).
 *   3. Hand the resulting TransportationProblem (see allocate.ts) to
 *      allocateLp(), which returns final per-(account × fund) values. A
 *      fund may blend several asset classes (VT = 65% US + 35% intl); its
 *      buys and sells move every component in lockstep, which the LP
 *      encodes natively.
 *   4. Translate the deltas into Trades with human-readable reasons,
 *      per-account breakdowns, the resulting allocation (a blend's value
 *      split across its component classes by largest remainder), and
 *      warnings for gaps that are structurally stuck.
 *
 * All money math is done in integer cents; all weights are integer basis
 * points. Nothing depends on input array order — every tie is broken by a
 * stable id comparison and the LP model is built in sorted order — so the
 * result is identical no matter how the caller orders accounts, funds,
 * holdings, or targets.
 */
export function rebalance(portfolio: Portfolio, targets: Target[], options: RebalanceOptions): RebalanceResult {
  validate(portfolio, targets, options);

  const fundsById = new Map(portfolio.funds.map((f) => [f.id, f]));
  const assetClassesById = new Map(portfolio.assetClasses.map((ac) => [ac.id, ac]));
  const accountsById = new Map(portfolio.accounts.map((a) => [a.id, a]));

  const allowSelling = options.allowSelling ?? false;
  const sellInTaxableAccounts = options.sellInTaxableAccounts ?? false;
  const optimizeAssetLocation = options.optimizeAssetLocation ?? false;
  const toleranceBps = options.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  const minTradeCents = options.minTradeCents ?? 0;

  // Positive-weight composition per fund (zero-weight entries are edit-time
  // noise and treated as absent everywhere below).
  const weightsByFund = new Map<string, Map<string, number>>(
    portfolio.funds.map((f) => [f.id, new Map(Object.entries(f.assetClasses).filter(([, weight]) => weight > 0))]),
  );

  // --- Step 1: current holdings per account, by fund ---
  const heldFundValues = new Map<string, Map<string, number>>();
  for (const account of portfolio.accounts) {
    heldFundValues.set(account.id, new Map());
  }
  let currentPortfolioTotal = 0;
  for (const holding of portfolio.holdings) {
    const fundRow = heldFundValues.get(holding.accountId)!;
    fundRow.set(holding.fundId, (fundRow.get(holding.fundId) ?? 0) + holding.value);
    currentPortfolioTotal += holding.value;
  }

  // --- earmarked contribution cash, per account ---
  const accountCash = new Map<string, number>();
  let totalContribution = 0;
  for (const contribution of options.contributions) {
    accountCash.set(contribution.accountId, (accountCash.get(contribution.accountId) ?? 0) + contribution.amount);
    totalContribution += contribution.amount;
  }

  for (const account of portfolio.accounts) {
    if ((accountCash.get(account.id) ?? 0) > 0 && account.availableFundIds.length === 0) {
      throw new Error(`Account "${account.id}" received a contribution but has no availableFundIds to invest it in.`);
    }
  }

  const newTotal = currentPortfolioTotal + totalContribution;
  if (newTotal > MAX_PORTFOLIO_CENTS) {
    throw new Error(
      `Portfolio total (holdings + contributions) is ${newTotal} cents, above the supported maximum of ` +
        `${MAX_PORTFOLIO_CENTS} (about $9 billion).`,
    );
  }

  // --- Step 2: target dollars per asset class ---
  const demands = proportionalAllocate(
    newTotal,
    targets.map((t) => ({ key: t.assetClassId, weight: t.weight })),
  );

  // --- Steps 3-5: delegate placement to the allocation seam ---
  const problem: TransportationProblem = {
    accounts: portfolio.accounts.map((account) => ({ id: account.id, taxType: account.taxType })),
    assetClasses: portfolio.assetClasses.map((assetClass) => ({
      id: assetClass.id,
      taxPreference: assetClass.taxPreference ?? "neutral",
    })),
    funds: portfolio.funds.map((fund) => ({ id: fund.id, weights: weightsByFund.get(fund.id)! })),
    cash: accountCash,
    demands,
    current: heldFundValues,
    buyable: (accountId, fundId) => accountsById.get(accountId)!.availableFundIds.includes(fundId),
    sellable: (accountId, fundId) => {
      if (!allowSelling) return 0;
      if (accountsById.get(accountId)!.taxType === "taxable" && !sellInTaxableAccounts) return 0;
      return heldFundValues.get(accountId)!.get(fundId) ?? 0;
    },
    preferenceRank: (accountId, fundId) => {
      const menu = accountsById.get(accountId)!.availableFundIds;
      const index = menu.indexOf(fundId);
      // Held-but-not-buyable funds rank after every menu entry.
      return index === -1 ? menu.length : index;
    },
    // ±toleranceBps of target weight, expressed in dollars of the new total.
    toleranceCents: Math.floor((newTotal * toleranceBps) / TOTAL_BPS),
    minTradeCents,
    optimizeAssetLocation,
  };

  const allocation = allocateLp(problem);

  // --- translate allocation deltas (x[a][f] - H[a][f]) into trades ---

  /** "tax-advantaged" / "taxable" — the account kind a non-neutral preference names. */
  const preferredKind = (preference: TaxPreference): string =>
    preference === "prefer_tax_advantaged" ? "tax-advantaged" : "taxable";

  /** "65% US Stocks, 35% International Stocks" — a blend's composition for trade reasons. */
  const describeBlend = (weights: Map<string, number>): string =>
    [...weights.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([classId, weight]) => `${formatBpsAsPercent(weight)} ${assetClassesById.get(classId)!.name}`)
      .join(", ");

  // Pre-trade class totals in integer cents (a blend's value split across
  // its components by largest remainder). Reasons are phrased against
  // these, so a trade never claims a class is below target when the table
  // next to it says otherwise; reused later for the allocation report.
  const currentTotals = new Map<string, number>();
  const resultingTotals = new Map<string, number>();
  for (const assetClass of portfolio.assetClasses) {
    currentTotals.set(assetClass.id, 0);
    resultingTotals.set(assetClass.id, 0);
  }
  const addSplit = (totals: Map<string, number>, fundId: string, value: number): void => {
    const weights = weightsByFund.get(fundId)!;
    const shares = proportionalAllocate(
      value,
      [...weights.entries()].map(([key, weight]) => ({ key, weight })),
    );
    for (const [classId, share] of shares) {
      totals.set(classId, (totals.get(classId) ?? 0) + share);
    }
  };
  for (const account of portfolio.accounts) {
    for (const [fundId, value] of heldFundValues.get(account.id)!) addSplit(currentTotals, fundId, value);
  }
  const belowTarget = (classId: string): boolean =>
    (currentTotals.get(classId) ?? 0) < (demands.get(classId) ?? 0);
  const aboveTarget = (classId: string): boolean =>
    (currentTotals.get(classId) ?? 0) > (demands.get(classId) ?? 0);

  const trades: Trade[] = [];
  const accountsByIdOrder = [...portfolio.accounts].sort((a, b) => a.id.localeCompare(b.id));
  for (const account of accountsByIdOrder) {
    const row = allocation.x.get(account.id)!;
    const heldRow = heldFundValues.get(account.id)!;
    for (const fundId of [...new Set([...row.keys(), ...heldRow.keys()])].sort()) {
      const delta = (row.get(fundId) ?? 0) - (heldRow.get(fundId) ?? 0);
      if (delta === 0) continue;
      const fund = fundsById.get(fundId)!;
      const weights = weightsByFund.get(fundId)!;
      const label = fund.ticker ?? fund.name;
      const soleClassId = weights.size === 1 ? weights.keys().next().value! : undefined;
      if (delta > 0) {
        // "Below target" is only claimed when it's true. A buy that fills no
        // gap is surplus-cash placement (cash may not sit idle, so it lands
        // per the documented tie-breaks) — unless the account received no
        // cash at all, in which case it is sell-funded: the receiving side
        // of a relocation (tax-preferred placement, a restricted-menu move,
        // or buying back the untouched slice of a partly-sold blend).
        const fillsGap = soleClassId !== undefined ? belowTarget(soleClassId) : [...weights.keys()].some(belowTarget);
        const hasCash = (accountCash.get(account.id) ?? 0) > 0;
        let reason: string;
        if (soleClassId !== undefined) {
          const assetClass = assetClassesById.get(soleClassId)!;
          const className = assetClass.name;
          const preference = assetClass.taxPreference ?? "neutral";
          if (fillsGap) {
            reason = `${className} is below target; buying ${formatDollars(delta)} of ${label} in ${account.name}.`;
          } else if (hasCash) {
            reason =
              `${className} is at or above target; investing ${formatDollars(delta)} of surplus contribution ` +
              `cash in ${label} in ${account.name}.`;
          } else if (
            optimizeAssetLocation &&
            preference !== "neutral" &&
            taxTypeRank(preference, account.taxType) === 0
          ) {
            reason =
              `${className} prefers ${preferredKind(preference)} accounts; buying ${formatDollars(delta)} of ` +
              `${label} in ${account.name} to relocate it here.`;
          } else {
            reason =
              `Buying ${formatDollars(delta)} of ${label} in ${account.name} to restore ${className} ` +
              `sold from other positions.`;
          }
        } else if (fillsGap) {
          reason =
            `Buying ${formatDollars(delta)} of ${label} (${describeBlend(weights)}) in ${account.name} ` +
            `to close underweight asset classes.`;
        } else if (hasCash) {
          reason =
            `Investing ${formatDollars(delta)} of surplus contribution cash in ${label} ` +
            `(${describeBlend(weights)}) in ${account.name}; none of its classes is below target.`;
        } else {
          reason =
            `Buying ${formatDollars(delta)} of ${label} (${describeBlend(weights)}) in ${account.name} ` +
            `to restore its asset classes sold from other positions.`;
        }
        trades.push({ accountId: account.id, fundId, action: "buy", amount: delta, reason });
      } else {
        // A single-class sell of a class that isn't above target can only be
        // a relocation: the class floor forbids shrinking its total, so the
        // dollars are repurchased in another account. When location
        // optimization is on and the class disprefers this account's tax
        // type, that preference is the move's motive — say so.
        let reason: string;
        if (soleClassId !== undefined) {
          const assetClass = assetClassesById.get(soleClassId)!;
          const className = assetClass.name;
          const preference = assetClass.taxPreference ?? "neutral";
          if (aboveTarget(soleClassId)) {
            reason =
              `${className} is above target; selling ${formatDollars(-delta)} of ${label} in ${account.name} ` +
              `to fund underweight asset classes.`;
          } else if (
            optimizeAssetLocation &&
            preference !== "neutral" &&
            taxTypeRank(preference, account.taxType) !== 0
          ) {
            reason =
              `${className} prefers ${preferredKind(preference)} accounts; selling ${formatDollars(-delta)} of ` +
              `${label} in ${account.name} to relocate it.`;
          } else {
            reason =
              `Selling ${formatDollars(-delta)} of ${label} in ${account.name} to relocate ${className} to ` +
              `another account, freeing this one for ${optimizeAssetLocation ? "asset classes needed here" : "underweight classes"}.`;
          }
        } else {
          reason =
            `Selling ${formatDollars(-delta)} of ${label} (${describeBlend(weights)}) in ${account.name} ` +
            `to fund underweight asset classes.`;
        }
        trades.push({ accountId: account.id, fundId, action: "sell", amount: -delta, reason });
      }
    }
  }
  // Sells before buys within each account (the natural execution order).
  trades.sort(
    (a, b) =>
      a.accountId.localeCompare(b.accountId) ||
      (a.action === b.action ? 0 : a.action === "sell" ? -1 : 1) ||
      a.fundId.localeCompare(b.fundId),
  );

  // Warnings are for things the user can act on. A gap left open merely
  // because contributions ran out is not one of them — the result's
  // allocation data already shows every shortfall — so only structural
  // problems are reported: no account offers the class at all, the accounts
  // that do got no cash, or selling was enabled but blocked.
  const warnings: string[] = [];
  for (const w of allocation.warnings) {
    const assetClass = assetClassesById.get(w.assetClassId)!;
    if (allowSelling) {
      warnings.push(
        `${assetClass.name} is still ${formatDollars(w.remainingGap)} under target even with selling enabled` +
          (sellInTaxableAccounts ? "." : " (selling in taxable accounts is disabled)."),
      );
      continue;
    }
    const offering = portfolio.accounts
      .filter((account) => accountHasFundFor(account, w.assetClassId, weightsByFund))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (offering.length === 0) {
      warnings.push(
        `${assetClass.name} is ${formatDollars(w.remainingGap)} under target, but no account offers a fund for it.`,
      );
    } else if (offering.every((account) => (accountCash.get(account.id) ?? 0) === 0)) {
      const names = offering.map((account) => account.name).join(", ");
      warnings.push(
        `${assetClass.name} is ${formatDollars(w.remainingGap)} under target, but ` +
          (offering.length === 1
            ? `only ${names} offers a fund for it, and it received no contribution.`
            : `the accounts offering a fund for it (${names}) received no contributions.`),
      );
    }
    // Otherwise: funded accounts offer it and the cash simply went to
    // bigger gaps — visible in the allocation, not warning-worthy.
  }

  // Asset-location feedback. Relocation needs selling, so everything here
  // is gated on allowSelling; each warning states exact dollars the user
  // can verify against the tables. The cases form a guidance chain — each
  // step's warning names the next lever to pull:
  //   1. mode off, relocation possible → suggest the option (naming
  //      taxable selling too when the move needs it);
  //   2. mode on, blocked only by the taxable-sell guard → name the guard;
  //   3. mode on, but no preferred-type account offers a fund for the
  //      class → the fund menus are the blocker, not the settings.
  // Cases 1–2 are counterfactuals, not heuristics: the allocator is re-run
  // with the mode forced on (and the taxable guard lifted), so they never
  // fire when relocation is impossible for other reasons (no fund, no
  // capacity, minTradeCents) and the dollars are exactly what the named
  // settings unlock.
  const nonNeutralClasses = portfolio.assetClasses.filter(
    (assetClass) => (assetClass.taxPreference ?? "neutral") !== "neutral",
  );
  if (allowSelling && nonNeutralClasses.length > 0) {
    /** Exact cent-basis-points of the class across the accounts passing the filter. */
    const exposureCentBps = (
      x: Map<string, Map<string, number>>,
      classId: string,
      accountFilter: (account: Account) => boolean,
    ): number => {
      let total = 0;
      for (const account of portfolio.accounts) {
        if (!accountFilter(account)) continue;
        for (const [fundId, value] of x.get(account.id) ?? []) {
          total += value * (weightsByFund.get(fundId)!.get(classId) ?? 0);
        }
      }
      return total;
    };
    const inPreferred = (x: Map<string, Map<string, number>>, classId: string, pref: TaxPreference): number =>
      exposureCentBps(x, classId, (account) => taxTypeRank(pref, account.taxType) === 0);
    // Slack: separate runs round floats to cents independently, so up to a
    // cent per position of repair noise can differ between them; anything
    // within the tolerance band is as ignorable as band-scale drift.
    const slackCents = problem.toleranceCents + portfolio.holdings.length + portfolio.accounts.length;

    // Best reachable placement with the mode on and the taxable guard
    // lifted. When both are already active this is the actual result, so
    // no extra solve (and cases 1–2 correctly stay silent).
    const fullPotential =
      optimizeAssetLocation && sellInTaxableAccounts
        ? allocation
        : allocateLp({
            ...problem,
            optimizeAssetLocation: true,
            sellable: (accountId, fundId) => heldFundValues.get(accountId)!.get(fundId) ?? 0,
          });
    // Same but keeping the current sell guards — tells case 1 whether
    // flipping the mode alone would already plan the trades.
    const guardedPotential = optimizeAssetLocation
      ? allocation
      : sellInTaxableAccounts
        ? fullPotential
        : allocateLp({ ...problem, optimizeAssetLocation: true });

    const relocatable = nonNeutralClasses
      .flatMap((assetClass) => {
        const pref = assetClass.taxPreference!;
        const actualCentBps = inPreferred(allocation.x, assetClass.id, pref);
        const fullGain = Math.round((inPreferred(fullPotential.x, assetClass.id, pref) - actualCentBps) / TOTAL_BPS);
        const guardedGain = Math.round(
          (inPreferred(guardedPotential.x, assetClass.id, pref) - actualCentBps) / TOTAL_BPS,
        );
        return fullGain > slackCents ? [{ assetClass, pref, fullGain, guardedGain }] : [];
      })
      .sort((a, b) => b.fullGain - a.fullGain || a.assetClass.id.localeCompare(b.assetClass.id));
    for (const { assetClass, pref, fullGain, guardedGain } of relocatable) {
      const move = `${assetClass.name} could move ${formatDollars(fullGain)} into ${preferredKind(pref)} accounts`;
      if (optimizeAssetLocation) {
        warnings.push(`${move}, but selling in taxable accounts is disabled.`);
      } else if (guardedGain >= fullGain - slackCents) {
        warnings.push(`${move}; enabling asset-location optimization would plan the trades.`);
      } else {
        warnings.push(`${move}; enabling asset-location optimization and taxable selling would plan the trades.`);
      }
    }

    // Case 3 — menus, not settings: the mode is on but the class has
    // nowhere preferred to go, because no account of the preferred type
    // offers a fund exposing it. (Whenever this holds, the counterfactual
    // gain above is structurally zero, so the two warnings never overlap.)
    if (optimizeAssetLocation) {
      const stuck = nonNeutralClasses
        .flatMap((assetClass) => {
          const pref = assetClass.taxPreference!;
          const offered = portfolio.accounts.some(
            (account) =>
              taxTypeRank(pref, account.taxType) === 0 && accountHasFundFor(account, assetClass.id, weightsByFund),
          );
          if (offered) return [];
          const dispreferredCents = Math.round(
            (exposureCentBps(allocation.x, assetClass.id, () => true) -
              inPreferred(allocation.x, assetClass.id, pref)) /
              TOTAL_BPS,
          );
          return dispreferredCents > slackCents ? [{ assetClass, pref, dispreferredCents }] : [];
        })
        .sort((a, b) => b.dispreferredCents - a.dispreferredCents || a.assetClass.id.localeCompare(b.assetClass.id));
      for (const { assetClass, pref, dispreferredCents } of stuck) {
        warnings.push(
          `${assetClass.name} prefers ${preferredKind(pref)} accounts, but no ${preferredKind(pref)} account ` +
            `offers a fund for it, so ${formatDollars(dispreferredCents)} cannot be relocated.`,
        );
      }
    }
  }

  // --- per-account before/after breakdown ---
  const tradeDeltas = new Map<string, Map<string, number>>();
  for (const trade of trades) {
    const row = tradeDeltas.get(trade.accountId) ?? new Map<string, number>();
    const delta = trade.action === "buy" ? trade.amount : -trade.amount;
    row.set(trade.fundId, (row.get(trade.fundId) ?? 0) + delta);
    tradeDeltas.set(trade.accountId, row);
  }
  const accounts = accountsByIdOrder.map((account) => {
    const fundRow = heldFundValues.get(account.id)!;
    const deltas = tradeDeltas.get(account.id) ?? new Map<string, number>();
    const positions = [...new Set([...fundRow.keys(), ...deltas.keys()])].sort().map((fundId) => {
      const currentValue = fundRow.get(fundId) ?? 0;
      const tradeDelta = deltas.get(fundId) ?? 0;
      return { fundId, currentValue, tradeDelta, finalValue: currentValue + tradeDelta };
    });
    const contribution = accountCash.get(account.id) ?? 0;
    const currentTotal = positions.reduce((sum, p) => sum + p.currentValue, 0);
    return { accountId: account.id, contribution, currentTotal, finalTotal: currentTotal + contribution, positions };
  });

  // --- resulting allocation & deviation, post-trade ---
  // Same largest-remainder splitting as the pre-trade totals above, so class
  // totals stay integer cents and every fund's value is conserved exactly
  // across its components.
  for (const account of portfolio.accounts) {
    for (const [fundId, value] of allocation.x.get(account.id)!) addSplit(resultingTotals, fundId, value);
  }

  const resultingWeightByAssetClass = proportionalAllocate(
    TOTAL_BPS,
    [...resultingTotals.entries()].map(([key, value]) => ({ key, weight: value })),
  );

  const resultingAllocation: AllocationEntry[] = [...resultingTotals.keys()].sort().map((assetClassId) => ({
    assetClassId,
    value: resultingTotals.get(assetClassId) ?? 0,
    weight: resultingWeightByAssetClass.get(assetClassId) ?? 0,
    currentValue: currentTotals.get(assetClassId) ?? 0,
    targetValue: demands.get(assetClassId) ?? 0,
  }));

  const targetWeightByAssetClass = new Map(targets.map((t) => [t.assetClassId, t.weight]));
  const deviationAssetClassIds = new Set<string>([...targetWeightByAssetClass.keys(), ...resultingTotals.keys()]);
  const deviationFromTarget: DeviationEntry[] = [...deviationAssetClassIds].sort().map((assetClassId) => {
    const targetWeight = targetWeightByAssetClass.get(assetClassId) ?? 0;
    const actualWeight = resultingWeightByAssetClass.get(assetClassId) ?? 0;
    return { assetClassId, targetWeight, actualWeight, deviationBps: actualWeight - targetWeight };
  });

  return { trades, accounts, resultingAllocation, deviationFromTarget, warnings };
}

/**
 * Largest supported post-contribution portfolio total, in integer cents
 * (~$9.007 billion). The exact class-exposure math multiplies cents by
 * basis points, and staying under this bound keeps every such product —
 * and their portfolio-wide sums — inside Number.MAX_SAFE_INTEGER; it also
 * keeps LP float error far below the solver's epsilons. Enforced up front
 * so exceeding it is a clear message instead of a numeric cliff.
 */
const MAX_PORTFOLIO_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / TOTAL_BPS);

/**
 * Distributes `totalToDistribute` (an integer) across `weights` in
 * proportion to each entry's weight, using largest-remainder rounding so
 * the shares sum to exactly `totalToDistribute` despite integer truncation.
 * Ties in the remainder are broken by `key` so the result never depends on
 * input array order. Used for target-dollars-per-asset-class (weights are
 * basis points), resulting-weight-per-asset-class (weights are dollar
 * values), and splitting a blended fund's value across its component
 * classes, which is why "weight" here is a unitless ratio, not specifically
 * basis points or cents.
 */
function proportionalAllocate(
  totalToDistribute: number,
  weights: Array<{ key: string; weight: number }>,
): Map<string, number> {
  const result = new Map<string, number>();
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

  if (totalWeight <= 0 || totalToDistribute <= 0) {
    for (const w of weights) result.set(w.key, 0);
    return result;
  }

  const shares = weights.map((w) => {
    const exact = (totalToDistribute * w.weight) / totalWeight;
    const floor = Math.floor(exact);
    return { key: w.key, floor, remainder: exact - floor };
  });

  const allocated = shares.reduce((sum, s) => sum + s.floor, 0);
  let remaining = totalToDistribute - allocated;

  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));
  for (const s of byRemainder) {
    if (remaining <= 0) break;
    s.floor += 1;
    remaining -= 1;
  }

  for (const s of shares) result.set(s.key, s.floor);
  return result;
}

/** Whether the account's menu offers any exposure (weight > 0) to the asset class. */
function accountHasFundFor(
  account: Account,
  assetClassId: string,
  weightsByFund: Map<string, Map<string, number>>,
): boolean {
  return account.availableFundIds.some((id) => (weightsByFund.get(id)?.get(assetClassId) ?? 0) > 0);
}

/** "6500" bps → "65%"; keeps fractional percents readable ("12.5%"). */
function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function formatDollars(cents: number): string {
  const dollars = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "-" : ""}$${dollars}`;
}

/** Throws when two items share a (trimmed, case-folded) non-blank name. `kindPlural` e.g. "Accounts". */
function requireUniqueNames(kindPlural: string, items: ReadonlyArray<{ id: string; name: string }>): void {
  const idByName = new Map<string, string>();
  for (const item of items) {
    const name = item.name.trim().toLowerCase();
    if (!name) continue;
    const other = idByName.get(name);
    if (other !== undefined) {
      throw new Error(
        `${kindPlural} "${other}" and "${item.id}" are both named "${item.name.trim()}" — names must be unique.`,
      );
    }
    idByName.set(name, item.id);
  }
}

function validate(portfolio: Portfolio, targets: Target[], options: RebalanceOptions): void {
  const assetClassIds = new Set(portfolio.assetClasses.map((a) => a.id));
  const fundIds = new Set(portfolio.funds.map((f) => f.id));
  const accountIds = new Set(portfolio.accounts.map((a) => a.id));

  if (assetClassIds.size !== portfolio.assetClasses.length) throw new Error("Duplicate AssetClass id.");
  if (fundIds.size !== portfolio.funds.length) throw new Error("Duplicate Fund id.");
  if (accountIds.size !== portfolio.accounts.length) throw new Error("Duplicate Account id.");

  for (const [kind, ids] of [
    ["AssetClass", assetClassIds],
    ["Fund", fundIds],
    ["Account", accountIds],
  ] as const) {
    for (const id of ids) {
      if (id.trim() === "") throw new Error(`${kind} ids must be non-empty, got ${JSON.stringify(id)}.`);
    }
  }

  // Tickers identify funds to the user (trades are displayed by ticker), so
  // two funds sharing one would make the output ambiguous. Case-insensitive;
  // ticker-less funds (e.g. named 401(k) menu entries) never collide.
  const fundIdByTicker = new Map<string, string>();
  for (const fund of portfolio.funds) {
    const ticker = fund.ticker?.trim().toUpperCase();
    if (!ticker) continue;
    const other = fundIdByTicker.get(ticker);
    if (other !== undefined) {
      throw new Error(`Funds "${other}" and "${fund.id}" both have ticker "${ticker}" — tickers must be unique.`);
    }
    fundIdByTicker.set(ticker, fund.id);
  }

  // Likewise, names are the only identity asset classes and accounts have in
  // the output, so duplicates make every table ambiguous. (Fund *names* are
  // deliberately not checked: share classes legitimately reuse one — VTI and
  // VTSAX are both "Vanguard Total Stock Market" — and funds are identified
  // by ticker, checked above.) Case-insensitive; blank names never collide.
  requireUniqueNames("Asset classes", portfolio.assetClasses);
  requireUniqueNames("Accounts", portfolio.accounts);
  // A ticker-less fund is displayed by name, so *among ticker-less funds*
  // names must be unique too. Funds with tickers may freely share a name —
  // share classes do (VTI and VTSAX are both "Vanguard Total Stock Market").
  requireUniqueNames(
    "Ticker-less funds",
    portfolio.funds.filter((f) => !f.ticker?.trim()),
  );

  for (const fund of portfolio.funds) {
    const entries = Object.entries(fund.assetClasses);
    if (entries.length === 0) {
      throw new Error(`Fund "${fund.id}" must list at least one asset class in assetClasses.`);
    }
    let weightSum = 0;
    for (const [assetClassId, weight] of entries) {
      if (!assetClassIds.has(assetClassId)) {
        throw new Error(`Fund "${fund.id}" references unknown assetClassId "${assetClassId}".`);
      }
      if (!Number.isInteger(weight) || weight < 0) {
        throw new Error(
          `Fund "${fund.id}" weight for "${assetClassId}" must be a non-negative integer number of basis points, ` +
            `got ${weight}.`,
        );
      }
      weightSum += weight;
    }
    if (weightSum !== TOTAL_BPS) {
      throw new Error(
        `Fund "${fund.id}" asset-class weights must total exactly 100%, got ` +
          `${formatBpsAsPercent(weightSum)} (${weightSum} of ${TOTAL_BPS} basis points).`,
      );
    }
  }

  for (const account of portfolio.accounts) {
    const seen = new Set<string>();
    for (const fundId of account.availableFundIds) {
      if (!fundIds.has(fundId)) {
        throw new Error(`Account "${account.id}" availableFundIds references unknown fund "${fundId}".`);
      }
      if (seen.has(fundId)) {
        throw new Error(`Account "${account.id}" lists fund "${fundId}" more than once in availableFundIds.`);
      }
      seen.add(fundId);
    }
  }

  for (const holding of portfolio.holdings) {
    if (!accountIds.has(holding.accountId)) {
      throw new Error(`Holding references unknown account "${holding.accountId}".`);
    }
    if (!fundIds.has(holding.fundId)) {
      throw new Error(`Holding references unknown fund "${holding.fundId}".`);
    }
    if (!Number.isInteger(holding.value) || holding.value < 0) {
      throw new Error(`Holding value must be a non-negative integer number of cents, got ${holding.value}.`);
    }
  }

  const seenTargets = new Set<string>();
  let weightSum = 0;
  for (const target of targets) {
    if (!assetClassIds.has(target.assetClassId)) {
      throw new Error(`Target references unknown assetClassId "${target.assetClassId}".`);
    }
    if (seenTargets.has(target.assetClassId)) {
      throw new Error(`Duplicate target for assetClassId "${target.assetClassId}".`);
    }
    seenTargets.add(target.assetClassId);
    if (!Number.isInteger(target.weight) || target.weight < 0) {
      throw new Error(`Target weight must be a non-negative integer number of basis points, got ${target.weight}.`);
    }
    weightSum += target.weight;
  }
  if (weightSum !== TOTAL_BPS) {
    throw new Error(
      `Target weights must total exactly 100%, got ${formatBpsAsPercent(weightSum)} ` +
        `(${weightSum} of ${TOTAL_BPS} basis points).`,
    );
  }

  for (const contribution of options.contributions) {
    if (!accountIds.has(contribution.accountId)) {
      throw new Error(`Contribution references unknown account "${contribution.accountId}".`);
    }
    if (!Number.isInteger(contribution.amount) || contribution.amount < 0) {
      throw new Error(`Contribution amount must be a non-negative integer number of cents, got ${contribution.amount}.`);
    }
  }

  if (options.toleranceBps !== undefined) {
    if (!Number.isInteger(options.toleranceBps) || options.toleranceBps < 0 || options.toleranceBps > TOTAL_BPS) {
      throw new Error(`toleranceBps must be an integer between 0 and ${TOTAL_BPS}, got ${options.toleranceBps}.`);
    }
  }
  if (options.minTradeCents !== undefined) {
    if (!Number.isInteger(options.minTradeCents) || options.minTradeCents < 0) {
      throw new Error(`minTradeCents must be a non-negative integer number of cents, got ${options.minTradeCents}.`);
    }
  }
}
