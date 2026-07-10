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
      --optimizer <greedy|lp>                 allocation engine (default lp, a provably
                                              optimal linear program; greedy = the
                                              original waterfall)
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
  const dollars = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "-" : ""}$${dollars}`;
}

/** "+$400.00" / "-$400.00", or an em dash for zero (no trade). */
function formatDelta(cents: number): string {
  if (cents === 0) return "—";
  return `${cents > 0 ? "+" : ""}${formatCents(cents)}`;
}

/** Pads each column to its widest cell; first column left-aligned, rest right-aligned. */
function renderColumns(rows: string[][], indent: string): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
        .join("  ")
        .trimEnd(),
  );
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
  const deviationBpsByClassId = new Map(result.deviationFromTarget.map((d) => [d.assetClassId, d.deviationBps]));

  console.log("\nPortfolio by asset class:\n");
  const rows: string[][] = [["asset class", "current", "target", "trades", "final", "vs target"]];
  for (const entry of result.resultingAllocation) {
    const deviationBps = deviationBpsByClassId.get(entry.assetClassId) ?? 0;
    const vsTarget = entry.value - entry.targetValue;
    rows.push([
      namesByClassId.get(entry.assetClassId) ?? entry.assetClassId,
      formatCents(entry.currentValue),
      formatCents(entry.targetValue),
      formatDelta(entry.value - entry.currentValue),
      formatCents(entry.value),
      vsTarget === 0
        ? "on target"
        : `${formatDelta(vsTarget)} (${deviationBps >= 0 ? "+" : ""}${(deviationBps / 100).toFixed(1)}%)`,
    ]);
  }
  for (const line of renderColumns(rows, "  ")) console.log(line);
}

function printAccounts(scenario: Scenario, result: RebalanceResult): void {
  const accountsById = new Map(scenario.portfolio.accounts.map((a) => [a.id, a]));
  const fundsById = new Map(scenario.portfolio.funds.map((f) => [f.id, f]));

  console.log("\nAccounts:");
  for (const breakdown of result.accounts) {
    const account = accountsById.get(breakdown.accountId)!;
    console.log(`\n  ${account.name} (${account.taxType})`);
    const rows: string[][] = [["", "current", "trades", "final"]];
    for (const position of breakdown.positions) {
      const fund = fundsById.get(position.fundId)!;
      rows.push([
        fund.ticker ?? fund.name,
        formatCents(position.currentValue),
        formatDelta(position.tradeDelta),
        formatCents(position.finalValue),
      ]);
    }
    const totalLabel = breakdown.contribution > 0 ? `total (+${formatCents(breakdown.contribution)} cash in)` : "total";
    rows.push([
      totalLabel,
      formatCents(breakdown.currentTotal),
      formatDelta(breakdown.finalTotal - breakdown.currentTotal),
      formatCents(breakdown.finalTotal),
    ]);
    for (const line of renderColumns(rows, "    ")) console.log(line);
  }
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
      optimizer: { type: "string" },
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
  if (values.optimizer !== undefined) {
    if (values.optimizer !== "greedy" && values.optimizer !== "lp") {
      throw new Error(`Invalid --optimizer "${values.optimizer}": expected "greedy" or "lp".`);
    }
    options.optimizer = values.optimizer;
  }

  const result = rebalance(scenario.portfolio, scenario.targets, options);

  printTrades(scenario, result);
  printAllocation(scenario, result);
  printAccounts(scenario, result);
  printWarnings(result);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
