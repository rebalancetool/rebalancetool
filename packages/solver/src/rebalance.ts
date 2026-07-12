import { allocate } from "./allocate.ts";
import { allocateLp } from "./allocate.lp.ts";
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
  Trade,
} from "./types.ts";

/**
 * ALGORITHM: greedy waterfall — a buy pass, then an optional sell pass.
 *
 * By default (allowSelling: false) this solver only ever recommends
 * purchases. It cannot then force a portfolio to exactly match its targets
 * in one pass — it can only spend new contribution cash to move the
 * portfolio *toward* target; given enough contributions over time, repeated
 * runs converge. With allowSelling: true, a second pass additionally sells
 * overweight positions to fund still-underweight classes *within the same
 * account* (cash raised by a sell never leaves its account), never selling
 * a class below its portfolio-level target, preferring sells in
 * tax-advantaged accounts, and never touching taxable positions unless
 * sellInTaxableAccounts is also set.
 *
 * Structurally, rebalance() reduces its inputs to a TransportationProblem
 * in (account × fund) space and delegates the placement decision to
 * allocate() (see allocate.ts — the optimizer-swappable seam); demands stay
 * in asset-class space, and each fund's class weights connect the two. A
 * fund may blend several asset classes (VT = 65% US + 35% intl); its buys
 * and sells move every component in lockstep, which the default LP engine
 * handles natively. The greedy engine predates blends and only supports
 * single-class funds (rebalance() rejects the combination up front). Steps
 * 3-5 below describe the greedy placement allocate() implements; the
 * allocator returns final per-(account × fund) values, which rebalance()
 * translates into Trades with human-readable reasons.
 *
 * Given a Portfolio and a set of Contributions (each earmarked to one
 * account — money never moves between accounts, mirroring the real-world
 * constraint that you can't deposit a 401k payroll contribution into an
 * IRA), the steps are:
 *
 *   1. Sum current holdings by asset class across *all* accounts combined,
 *      using nominal (not tax-adjusted) dollar values (a blended fund's
 *      value counts toward each component class in proportion to its
 *      weights).
 *   2. Add every contribution to the portfolio total to get the
 *      post-contribution total portfolio value, then compute each asset
 *      class's target dollar value at that new total (largest-remainder
 *      rounding so target dollars sum exactly to the new total despite
 *      integer-cent truncation). Each asset class's "gap" is
 *      max(0, targetDollars - currentDollars) — never negative, since we
 *      only buy.
 *   3. Repeatedly: find the asset class with the single largest remaining
 *      gap (ties broken by assetClassId for determinism). Among accounts
 *      that (a) still have uninvested contribution cash and (b) offer at
 *      least one fund in that asset class, rank them by the asset class's
 *      taxPreference (e.g. bonds usually want prefer_tax_advantaged
 *      accounts first) and then by account id. Buy into the highest-ranked
 *      account, choosing the earliest fund in that account's ordered
 *      availableFundIds among funds belonging to the target asset class.
 *      Spend min(gap, remaining cash in that account). This is a "waterfall"
 *      because each pass drains the biggest gap first; once a gap is fully
 *      closed or every eligible account runs dry, the next-biggest gap
 *      becomes the target.
 *   4. If no eligible account exists at all for an asset class's gap (no
 *      account with remaining cash offers a fund in it), the buy pass moves
 *      on to the next-largest gap rather than stalling. When selling is
 *      enabled, a sell pass then retries every remaining gap: it finds an
 *      account that can buy the underweight class and holds an overweight
 *      one, sells the overweight position (least-preferred fund first) and
 *      redeploys the proceeds in place. Any gap that survives both passes
 *      is reported as a warning. Everything is governed by the tolerance
 *      band (toleranceBps, default 50): a class within ±band of its target
 *      weight is treated as on-target — not bought toward, not sold down,
 *      not "fixed" by selling, and not warned about — so trivial drift never
 *      triggers trades.
 *   5. Contributions must be fully invested — cash cannot be left
 *      sitting idle in an account. So once every gap reachable from an
 *      account's contribution has been closed (or is permanently blocked),
 *      any cash still remaining in that account is invested into that
 *      account's single most-preferred fund (availableFundIds[0]), with a
 *      warning explaining why (this can happen when a contribution is larger
 *      than needed to close that account's share of the gaps).
 *
 * Every trade carries a human-readable `reason`. All money math is done in
 * integer cents; all weights are integer basis points. Iteration never
 * depends on input array order — every tie is broken by a stable id
 * comparison — so the result is identical no matter how the caller orders
 * accounts, funds, holdings, or targets.
 */
export function rebalance(portfolio: Portfolio, targets: Target[], options: RebalanceOptions): RebalanceResult {
  validate(portfolio, targets, options);

  const fundsById = new Map(portfolio.funds.map((f) => [f.id, f]));
  const assetClassesById = new Map(portfolio.assetClasses.map((ac) => [ac.id, ac]));
  const accountsById = new Map(portfolio.accounts.map((a) => [a.id, a]));

  const allowSelling = options.allowSelling ?? false;
  const sellInTaxableAccounts = options.sellInTaxableAccounts ?? false;
  const toleranceBps = options.toleranceBps ?? DEFAULT_TOLERANCE_BPS;
  const optimizer = options.optimizer ?? "lp";
  const minTradeCents = options.minTradeCents ?? 0;

  // Positive-weight composition per fund (zero-weight entries are edit-time
  // noise and treated as absent everywhere below).
  const weightsByFund = new Map<string, Map<string, number>>(
    portfolio.funds.map((f) => [f.id, new Map(Object.entries(f.assetClasses).filter(([, weight]) => weight > 0))]),
  );

  if (optimizer === "greedy") {
    const blended = portfolio.funds.find((f) => weightsByFund.get(f.id)!.size > 1);
    if (blended !== undefined) {
      throw new Error(
        `The "greedy" optimizer only supports single-asset-class funds, but "${blended.id}" blends ` +
          `${weightsByFund.get(blended.id)!.size} classes. Use the default "lp" optimizer.`,
      );
    }
  }

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
  };

  const allocation = optimizer === "lp" ? allocateLp(problem) : allocate(problem);

  // --- translate allocation deltas (x[a][f] - H[a][f]) into trades ---
  const leftoverByAccount = new Map<string, { fundId: string; amount: number }>();
  for (const w of allocation.warnings) {
    if (w.kind === "leftover_cash") leftoverByAccount.set(w.accountId, w);
  }

  /** "65% US Stocks, 35% International Stocks" — a blend's composition for trade reasons. */
  const describeBlend = (weights: Map<string, number>): string =>
    [...weights.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([classId, weight]) => `${formatBpsAsPercent(weight)} ${assetClassesById.get(classId)!.name}`)
      .join(", ");

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
        const leftover = leftoverByAccount.get(account.id);
        const leftoverPart = leftover !== undefined && leftover.fundId === fundId ? leftover.amount : 0;
        const gapPart = delta - leftoverPart;
        const reasons: string[] = [];
        if (gapPart > 0) {
          reasons.push(
            soleClassId !== undefined
              ? `${assetClassesById.get(soleClassId)!.name} is below target; buying ${formatDollars(gapPart)} of ` +
                  `${label} in ${account.name}.`
              : `Buying ${formatDollars(gapPart)} of ${label} (${describeBlend(weights)}) in ${account.name} ` +
                  `to close underweight asset classes.`,
          );
        }
        if (leftoverPart > 0) {
          reasons.push(
            `Investing ${formatDollars(leftoverPart)} of leftover contribution cash in ${label}, ` +
              `the most-preferred fund of ${account.name}.`,
          );
        }
        trades.push({
          accountId: account.id,
          fundId,
          action: "buy",
          amount: delta,
          reason: reasons.join(" "),
        });
      } else {
        trades.push({
          accountId: account.id,
          fundId,
          action: "sell",
          amount: -delta,
          reason:
            soleClassId !== undefined
              ? `${assetClassesById.get(soleClassId)!.name} is above target; selling ${formatDollars(-delta)} of ` +
                `${label} in ${account.name} to fund underweight asset classes.`
              : `Selling ${formatDollars(-delta)} of ${label} (${describeBlend(weights)}) in ${account.name} ` +
                `to fund underweight asset classes.`,
        });
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
    switch (w.kind) {
      case "unreachable_gap": {
        const assetClass = assetClassesById.get(w.assetClassId)!;
        if (allowSelling) {
          warnings.push(
            `${assetClass.name} is still ${formatDollars(w.remainingGap)} under target even with selling enabled` +
              (sellInTaxableAccounts ? "." : " (selling in taxable accounts is disabled)."),
          );
          break;
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
        break;
      }
      case "leftover_cash": {
        const account = accountsById.get(w.accountId)!;
        const fund = fundsById.get(w.fundId)!;
        warnings.push(
          `${account.name} had ${formatDollars(w.amount)} of contribution left after closing every reachable gap; ` +
            `invested it in ${fund.ticker ?? fund.name}, its most-preferred fund.`,
        );
        break;
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
  // A blended fund's dollars are split across its component classes by
  // largest-remainder on the weights, so class totals stay integer cents and
  // every fund's value is conserved exactly across its components.
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

function validate(portfolio: Portfolio, targets: Target[], options: RebalanceOptions): void {
  const assetClassIds = new Set(portfolio.assetClasses.map((a) => a.id));
  const fundIds = new Set(portfolio.funds.map((f) => f.id));
  const accountIds = new Set(portfolio.accounts.map((a) => a.id));

  if (assetClassIds.size !== portfolio.assetClasses.length) throw new Error("Duplicate AssetClass id.");
  if (fundIds.size !== portfolio.funds.length) throw new Error("Duplicate Fund id.");
  if (accountIds.size !== portfolio.accounts.length) throw new Error("Duplicate Account id.");

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
        `Fund "${fund.id}" asset-class weights must sum to exactly ${TOTAL_BPS} basis points, got ${weightSum}.`,
      );
    }
  }

  for (const account of portfolio.accounts) {
    for (const fundId of account.availableFundIds) {
      if (!fundIds.has(fundId)) {
        throw new Error(`Account "${account.id}" availableFundIds references unknown fund "${fundId}".`);
      }
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
    throw new Error(`Target weights must sum to exactly ${TOTAL_BPS} basis points, got ${weightSum}.`);
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
  if (options.optimizer !== undefined && options.optimizer !== "greedy" && options.optimizer !== "lp") {
    throw new Error(`optimizer must be "greedy" or "lp", got ${JSON.stringify(options.optimizer)}.`);
  }
}
