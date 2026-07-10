#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { rebalance } from "@rebalancer/solver";
import type { Contribution, Portfolio, Target } from "@rebalancer/solver";

interface ScenarioFile {
  portfolio: Portfolio;
  targets: Target[];
}

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

function main(): void {
  const { values } = parseArgs({
    options: {
      portfolio: { type: "string", short: "p" },
      contribution: { type: "string", short: "c", multiple: true },
    },
  });

  if (!values.portfolio) {
    console.error(
      'Usage: solve -p <scenario.json> [-c accountId:amountCents ...]\n' +
        "Example: pnpm solve -p packages/solver/fixtures/example.json -c taxable:40000 -c k401:15000 -c hsa:5000",
    );
    process.exitCode = 1;
    return;
  }

  const scenarioPath = resolve(process.cwd(), values.portfolio);
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioFile;

  const portfolio: Portfolio = scenario.portfolio;
  const contributions = (values.contribution ?? []).map(parseContributionArg);

  const result = rebalance(portfolio, scenario.targets, { contributions });

  console.table(
    result.trades.map((trade) => ({
      account: trade.accountId,
      fund: trade.fundId,
      action: trade.action,
      amount: `$${(trade.amount / 100).toFixed(2)}`,
      reason: trade.reason,
    })),
  );

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

main();
