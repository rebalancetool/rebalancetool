import type {
  Account,
  AllocationEntry,
  DeviationEntry,
  Fund,
  Portfolio,
  RebalanceOptions,
  RebalanceResult,
  Target,
  TaxPreference,
  TaxType,
  Trade,
} from "./types.ts";

/**
 * ALGORITHM: buy-only greedy waterfall.
 *
 * This solver only ever recommends purchases. It never sells, so it cannot
 * force a portfolio to exactly match its targets in one pass — it can only
 * spend new contribution cash to move the portfolio *toward* target. Given
 * enough contributions over time, repeated runs converge on target.
 *
 * Given a Portfolio and a set of Contributions (each earmarked to one
 * account — money never moves between accounts, mirroring the real-world
 * constraint that you can't deposit a 401k payroll contribution into an
 * IRA), the steps are:
 *
 *   1. Sum current holdings by asset class across *all* accounts combined,
 *      using nominal (not tax-adjusted) dollar values.
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
 *      account, choosing the highest-ranked fund in that account's
 *      fundPreference among funds belonging to the target asset class.
 *      Spend min(gap, remaining cash in that account). This is a "waterfall"
 *      because each pass drains the biggest gap first; once a gap is fully
 *      closed or every eligible account runs dry, the next-biggest gap
 *      becomes the target.
 *   4. If no eligible account exists at all for an asset class's gap (no
 *      account with remaining cash offers a fund in it), that gap is
 *      reported as unclosable for this run and a warning is emitted; the
 *      solver moves on to the next-largest gap rather than stalling.
 *   5. Contributions must be fully invested — cash cannot be left
 *      sitting idle in an account. So once every gap reachable from an
 *      account's contribution has been closed (or is permanently blocked),
 *      any cash still remaining in that account is invested into that
 *      account's single top-fundPreference fund, with a warning explaining
 *      why (this can happen when a contribution is larger than needed to
 *      close that account's share of the gaps).
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

  // --- Step 1: current holdings by asset class, across all accounts ---
  const currentTotals = new Map<string, number>();
  for (const assetClass of portfolio.assetClasses) currentTotals.set(assetClass.id, 0);
  let currentPortfolioTotal = 0;
  for (const holding of portfolio.holdings) {
    const fund = fundsById.get(holding.fundId)!;
    currentTotals.set(fund.assetClassId, (currentTotals.get(fund.assetClassId) ?? 0) + holding.value);
    currentPortfolioTotal += holding.value;
  }

  // --- earmarked contribution cash, per account ---
  const accountCash = new Map<string, number>();
  let totalContribution = 0;
  for (const contribution of options.contributions) {
    accountCash.set(contribution.accountId, (accountCash.get(contribution.accountId) ?? 0) + contribution.amount);
    totalContribution += contribution.amount;
  }

  const newTotal = currentPortfolioTotal + totalContribution;

  // --- Step 2: target dollars per asset class, and initial gaps ---
  const targetValueByAssetClass = proportionalAllocate(
    newTotal,
    targets.map((t) => ({ key: t.assetClassId, weight: t.weight })),
  );

  const gap = new Map<string, number>();
  for (const target of targets) {
    const targetValue = targetValueByAssetClass.get(target.assetClassId) ?? 0;
    const currentValue = currentTotals.get(target.assetClassId) ?? 0;
    gap.set(target.assetClassId, Math.max(0, targetValue - currentValue));
  }

  const warnings: string[] = [];
  const blocked = new Set<string>();
  const tradeMap = new Map<string, Trade>();

  function addTrade(accountId: string, fund: Fund, amount: number, reason: string): void {
    if (amount <= 0) return;
    const key = `${accountId}::${fund.id}`;
    const existing = tradeMap.get(key);
    if (existing) {
      existing.amount += amount;
      existing.reason += ` ${reason}`;
    } else {
      tradeMap.set(key, { accountId, fundId: fund.id, action: "buy", amount, reason });
    }
  }

  // --- Step 3 & 4: greedy waterfall ---
  while (true) {
    let bestAssetClassId: string | null = null;
    let bestGap = 0;
    for (const [assetClassId, g] of gap) {
      if (g <= 0 || blocked.has(assetClassId)) continue;
      if (g > bestGap || (g === bestGap && (bestAssetClassId === null || assetClassId < bestAssetClassId))) {
        bestGap = g;
        bestAssetClassId = assetClassId;
      }
    }
    if (bestAssetClassId === null) break;

    const assetClass = assetClassesById.get(bestAssetClassId)!;
    const eligible = portfolio.accounts
      .filter(
        (account) =>
          (accountCash.get(account.id) ?? 0) > 0 && accountHasFundFor(account, bestAssetClassId!, fundsById),
      )
      .sort((a, b) => {
        const rankA = taxTypeRank(assetClass.taxPreference ?? "neutral", a.taxType);
        const rankB = taxTypeRank(assetClass.taxPreference ?? "neutral", b.taxType);
        if (rankA !== rankB) return rankA - rankB;
        return a.id.localeCompare(b.id);
      });

    if (eligible.length === 0) {
      blocked.add(bestAssetClassId);
      warnings.push(
        `No account with remaining contribution cash offers a fund for "${assetClass.name}"; ` +
          `${formatDollars(bestGap)} of gap will remain unclosed this run.`,
      );
      continue;
    }

    const account = eligible[0]!;
    const fund = pickFund(account, bestAssetClassId, fundsById);
    const cash = accountCash.get(account.id)!;
    const amount = Math.min(bestGap, cash);

    addTrade(
      account.id,
      fund,
      amount,
      `${assetClass.name} is ${formatDollars(bestGap)} below target; buying ${fund.ticker ?? fund.name} in ${account.name}.`,
    );

    gap.set(bestAssetClassId, bestGap - amount);
    accountCash.set(account.id, cash - amount);
  }

  // --- Step 5: invest any leftover earmarked cash so nothing sits idle ---
  // Iterate accounts in id order (not input array order) so warnings/trades
  // are identical regardless of how the caller ordered portfolio.accounts.
  const accountsByIdOrder = [...portfolio.accounts].sort((a, b) => a.id.localeCompare(b.id));
  for (const account of accountsByIdOrder) {
    const remaining = accountCash.get(account.id) ?? 0;
    if (remaining <= 0) continue;

    const fallbackFundId =
      account.fundPreference.find((id) => account.availableFundIds.includes(id)) ?? account.availableFundIds[0];
    if (!fallbackFundId) {
      throw new Error(`Account "${account.id}" received a contribution but has no availableFundIds to invest it in.`);
    }
    const fund = fundsById.get(fallbackFundId)!;

    addTrade(
      account.id,
      fund,
      remaining,
      `Remaining reachable gaps for "${account.name}" are closed; investing leftover contribution in ` +
        `${fund.ticker ?? fund.name}, its top fund preference.`,
    );
    warnings.push(
      `Account "${account.name}" had ${formatDollars(remaining)} left after closing every reachable gap; ` +
        `invested it in ${fund.ticker ?? fund.name} rather than leaving it uninvested.`,
    );
    accountCash.set(account.id, 0);
  }

  const trades = [...tradeMap.values()].sort(
    (a, b) => a.accountId.localeCompare(b.accountId) || a.fundId.localeCompare(b.fundId),
  );

  // --- resulting allocation & deviation, post-trade ---
  const resultingTotals = new Map(currentTotals);
  for (const trade of trades) {
    const fund = fundsById.get(trade.fundId)!;
    resultingTotals.set(fund.assetClassId, (resultingTotals.get(fund.assetClassId) ?? 0) + trade.amount);
  }

  const resultingWeightByAssetClass = proportionalAllocate(
    10000,
    [...resultingTotals.entries()].map(([key, value]) => ({ key, weight: value })),
  );

  const resultingAllocation: AllocationEntry[] = [...resultingTotals.keys()].sort().map((assetClassId) => ({
    assetClassId,
    value: resultingTotals.get(assetClassId) ?? 0,
    weight: resultingWeightByAssetClass.get(assetClassId) ?? 0,
  }));

  const targetWeightByAssetClass = new Map(targets.map((t) => [t.assetClassId, t.weight]));
  const deviationAssetClassIds = new Set<string>([...targetWeightByAssetClass.keys(), ...resultingTotals.keys()]);
  const deviationFromTarget: DeviationEntry[] = [...deviationAssetClassIds].sort().map((assetClassId) => {
    const targetWeight = targetWeightByAssetClass.get(assetClassId) ?? 0;
    const actualWeight = resultingWeightByAssetClass.get(assetClassId) ?? 0;
    return { assetClassId, targetWeight, actualWeight, deviationBps: actualWeight - targetWeight };
  });

  return { trades, resultingAllocation, deviationFromTarget, warnings };
}

/**
 * Distributes `totalToDistribute` (an integer) across `weights` in
 * proportion to each entry's weight, using largest-remainder rounding so
 * the shares sum to exactly `totalToDistribute` despite integer truncation.
 * Ties in the remainder are broken by `key` so the result never depends on
 * input array order. Used both for target-dollars-per-asset-class (weights
 * are basis points) and resulting-weight-per-asset-class (weights are
 * dollar values), which is why "weight" here is a unitless ratio, not
 * specifically basis points or cents.
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

function accountHasFundFor(account: Account, assetClassId: string, fundsById: Map<string, Fund>): boolean {
  return account.availableFundIds.some((id) => fundsById.get(id)?.assetClassId === assetClassId);
}

/** Highest-ranked fund in `account.fundPreference` among its available funds for `assetClassId`. */
function pickFund(account: Account, assetClassId: string, fundsById: Map<string, Fund>): Fund {
  const candidates = account.availableFundIds
    .map((id) => fundsById.get(id))
    .filter((f): f is Fund => f !== undefined && f.assetClassId === assetClassId);

  candidates.sort((a, b) => {
    const rankA = account.fundPreference.indexOf(a.id);
    const rankB = account.fundPreference.indexOf(b.id);
    const normA = rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA;
    const normB = rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB;
    if (normA !== normB) return normA - normB;
    return a.id.localeCompare(b.id);
  });

  const best = candidates[0];
  if (!best) {
    throw new Error(`Account "${account.id}" has no available fund for asset class "${assetClassId}".`);
  }
  return best;
}

/** Lower rank = more preferred account for this asset class's tax preference. */
function taxTypeRank(preference: TaxPreference, taxType: TaxType): number {
  if (preference === "neutral") return 0;
  const isTaxAdvantaged = taxType === "tax_deferred" || taxType === "tax_free";
  if (preference === "prefer_tax_advantaged") return isTaxAdvantaged ? 0 : 1;
  return taxType === "taxable" ? 0 : 1; // prefer_taxable
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function validate(portfolio: Portfolio, targets: Target[], options: RebalanceOptions): void {
  const assetClassIds = new Set(portfolio.assetClasses.map((a) => a.id));
  const fundIds = new Set(portfolio.funds.map((f) => f.id));
  const accountIds = new Set(portfolio.accounts.map((a) => a.id));

  if (assetClassIds.size !== portfolio.assetClasses.length) throw new Error("Duplicate AssetClass id.");
  if (fundIds.size !== portfolio.funds.length) throw new Error("Duplicate Fund id.");
  if (accountIds.size !== portfolio.accounts.length) throw new Error("Duplicate Account id.");

  for (const fund of portfolio.funds) {
    if (!assetClassIds.has(fund.assetClassId)) {
      throw new Error(`Fund "${fund.id}" references unknown assetClassId "${fund.assetClassId}".`);
    }
  }

  for (const account of portfolio.accounts) {
    for (const fundId of account.availableFundIds) {
      if (!fundIds.has(fundId)) {
        throw new Error(`Account "${account.id}" availableFundIds references unknown fund "${fundId}".`);
      }
    }
    for (const fundId of account.fundPreference) {
      if (!fundIds.has(fundId)) {
        throw new Error(`Account "${account.id}" fundPreference references unknown fund "${fundId}".`);
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
  if (weightSum !== 10000) {
    throw new Error(`Target weights must sum to exactly 10000 basis points, got ${weightSum}.`);
  }

  for (const contribution of options.contributions) {
    if (!accountIds.has(contribution.accountId)) {
      throw new Error(`Contribution references unknown account "${contribution.accountId}".`);
    }
    if (!Number.isInteger(contribution.amount) || contribution.amount < 0) {
      throw new Error(`Contribution amount must be a non-negative integer number of cents, got ${contribution.amount}.`);
    }
  }
}
