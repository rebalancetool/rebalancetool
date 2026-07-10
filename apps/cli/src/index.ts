#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { rebalance, validateScenario } from "@rebalancer/solver";
import type { Contribution, RebalanceOptions, RebalanceResult, Scenario } from "@rebalancer/solver";

const USAGE = `Usage: solve -p <scenario.json> [overrides]

The scenario file is the complete input — portfolio, targets, contributions,
and options (see packages/solver/fixtures/*.json for the shape). Flags
override what the file says:

  -c, --contribution <accountId:amountCents>  replace the file's contributions
                                              (repeatable, e.g. -c taxable:40000)
      --sell                                  allow selling (options.allowSelling)
      --sell-taxable                          also allow sells in taxable accounts
                                              (implies --sell)
      --tolerance-bps <n>                     tolerance band in basis points
      --min-trade-cents <n>                   minimum sell-funded trade size
  -h, --help                                  show this help

Examples:
  pnpm solve -p packages/solver/fixtures/example.json
  pnpm solve -p packages/solver/fixtures/sell-required.json --sell
`;

/** Parses "accountId:amountCents", e.g. "taxable:40000" -> $400.00 into the taxable account. */
function parseContributionArg(raw: string): Contribution {
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Invalid --contribution "${raw}". Expected "accountId:amountCents", e.g. "taxable:40000".`);
  }
  const accountId = raw.slice(0, separatorIndex);
  const amount = Number(raw.slice(separatorIndex + 1));
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Invalid --contribution "${raw}": amount must be a non-negative integer number of cents.`);
  }
  return { accountId, amount };
}

function parseIntFlag(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${flag} "${raw}": expected a non-negative integer.`);
  }
  return value;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function printTrades(scenario: Scenario, result: RebalanceResult): void {
  if (result.trades.length === 0) {
    console.log("No trades needed.");
    return;
  }
  const accountsById = new Map(scenario.portfolio.accounts.map((a) => [a.id, a]));
  const fundsById = new Map(scenario.portfolio.funds.map((f) => [f.id, f]));

  console.log("Trades:");
  let currentAccountId = "";
  for (const trade of result.trades) {
    // Trades arrive sorted by account with sells before buys.
    if (trade.accountId !== currentAccountId) {
      const account = accountsById.get(trade.accountId)!;
      console.log(`\n  ${account.name} (${account.taxType})`);
      currentAccountId = trade.accountId;
    }
    const fund = fundsById.get(trade.fundId)!;
    const action = trade.action === "sell" ? "SELL" : "BUY ";
    const label = (fund.ticker ?? fund.name).padEnd(6);
    console.log(`    ${action} ${formatCents(trade.amount).padStart(12)}  ${label} ${trade.reason}`);
  }
}

function printAllocation(scenario: Scenario, result: RebalanceResult): void {
  const namesByClassId = new Map(scenario.portfolio.assetClasses.map((ac) => [ac.id, ac.name]));
  const valueByClassId = new Map(result.resultingAllocation.map((a) => [a.assetClassId, a.value]));

  console.log("\nResulting allocation:");
  console.table(
    result.deviationFromTarget.map((deviation) => ({
      "asset class": namesByClassId.get(deviation.assetClassId) ?? deviation.assetClassId,
      value: formatCents(valueByClassId.get(deviation.assetClassId) ?? 0),
      actual: formatBps(deviation.actualWeight),
      target: formatBps(deviation.targetWeight),
      "deviation (bps)": deviation.deviationBps,
    })),
  );
}

function printWarnings(result: RebalanceResult): void {
  if (result.warnings.length === 0) return;
  console.log("\nWarnings:");
  for (const warning of result.warnings) {
    console.log(`  - ${warning}`);
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string", short: "p" },
      contribution: { type: "string", short: "c", multiple: true },
      sell: { type: "boolean", default: false },
      "sell-taxable": { type: "boolean", default: false },
      "tolerance-bps": { type: "string" },
      "min-trade-cents": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.scenario) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const scenarioPath = resolve(process.cwd(), values.scenario);
  const scenario = validateScenario(JSON.parse(readFileSync(scenarioPath, "utf8")));

  const contributionOverrides = (values.contribution ?? []).map(parseContributionArg);
  const options: RebalanceOptions = {
    ...scenario.options,
    contributions: contributionOverrides.length > 0 ? contributionOverrides : scenario.contributions,
  };
  if (values.sell) options.allowSelling = true;
  if (values["sell-taxable"]) {
    options.allowSelling = true;
    options.sellInTaxableAccounts = true;
  }
  if (values["tolerance-bps"] !== undefined) {
    options.toleranceBps = parseIntFlag(values["tolerance-bps"], "--tolerance-bps");
  }
  if (values["min-trade-cents"] !== undefined) {
    options.minTradeCents = parseIntFlag(values["min-trade-cents"], "--min-trade-cents");
  }

  const result = rebalance(scenario.portfolio, scenario.targets, options);

  printTrades(scenario, result);
  printAllocation(scenario, result);
  printWarnings(result);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
