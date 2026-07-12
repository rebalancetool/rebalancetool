import { rebalance } from "@rebalancer/solver";
import type { RebalanceResult, Scenario } from "@rebalancer/solver";
import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { demoScenario } from "./demo-scenario.ts";
import { ResultView } from "./ResultView.tsx";

/**
 * ResultView is pure presentation, so these tests feed it a hand-written
 * RebalanceResult and assert on what the user sees — no solver logic is
 * exercised except in the one integration test at the bottom.
 */

const scenario: Scenario = {
  portfolio: {
    assetClasses: [
      { id: "us_stocks", name: "US Stocks" },
      { id: "us_bonds", name: "US Bonds" },
    ],
    funds: [
      { id: "vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", assetClasses: { "us_stocks": 10000 } },
      { id: "bnd", ticker: "BND", name: "Vanguard Total Bond Market ETF", assetClasses: { "us_bonds": 10000 } },
    ],
    accounts: [{ id: "ira", name: "Traditional IRA", taxType: "tax_deferred", availableFundIds: ["vti", "bnd"] }],
    holdings: [
      { accountId: "ira", fundId: "vti", value: 600000 },
      { accountId: "ira", fundId: "bnd", value: 400000 },
    ],
  },
  targets: [
    { assetClassId: "us_stocks", weight: 5000 },
    { assetClassId: "us_bonds", weight: 5000 },
  ],
  contributions: [],
};

const result: RebalanceResult = {
  trades: [
    { accountId: "ira", fundId: "vti", action: "sell", amount: 100000, reason: "US Stocks is above target; selling to fund underweight asset classes." },
    { accountId: "ira", fundId: "bnd", action: "buy", amount: 100000, reason: "US Bonds is below target; buying $1,000.00 of BND in Traditional IRA." },
  ],
  accounts: [
    {
      accountId: "ira",
      contribution: 0,
      currentTotal: 1000000,
      finalTotal: 1000000,
      positions: [
        { fundId: "bnd", currentValue: 400000, tradeDelta: 100000, finalValue: 500000 },
        { fundId: "vti", currentValue: 600000, tradeDelta: -100000, finalValue: 500000 },
      ],
    },
  ],
  resultingAllocation: [
    { assetClassId: "us_bonds", value: 500000, weight: 5000, currentValue: 400000, targetValue: 500000 },
    { assetClassId: "us_stocks", value: 500000, weight: 5000, currentValue: 600000, targetValue: 500000 },
  ],
  deviationFromTarget: [
    { assetClassId: "us_bonds", targetWeight: 5000, actualWeight: 5000, deviationBps: 0 },
    { assetClassId: "us_stocks", targetWeight: 5000, actualWeight: 5000, deviationBps: 0 },
  ],
  warnings: [],
};

test("renders trades grouped by account with action, fund, amount, and reason", () => {
  render(<ResultView scenario={scenario} result={result} />);

  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getByRole("heading", { name: /Traditional IRA/ })).toBeInTheDocument();
  expect(within(trades).getByText("SELL")).toBeInTheDocument();
  expect(within(trades).getByText("BUY")).toBeInTheDocument();
  expect(within(trades).getAllByText("$1,000.00")).toHaveLength(2);
  // The reason earns trust, so it must be visible text, not a tooltip.
  expect(within(trades).getByText(/US Stocks is above target/)).toBeVisible();
  expect(within(trades).getByText(/US Bonds is below target/)).toBeVisible();
});

test("renders the allocation table with on-target rows", () => {
  render(<ResultView scenario={scenario} result={result} />);

  const allocation = screen.getByRole("region", { name: "Portfolio by asset class" });
  const stocksRow = within(allocation).getByRole("row", { name: /US Stocks/ });
  expect(within(stocksRow).getByText("$6,000.00")).toBeInTheDocument(); // current
  expect(within(stocksRow).getByText("-$1,000.00")).toBeInTheDocument(); // trades delta
  expect(within(stocksRow).getByText("on target")).toBeInTheDocument();
});

test("renders per-account before/after positions with em dash for untouched values", () => {
  const untouched: RebalanceResult = {
    ...result,
    trades: [],
    accounts: [
      {
        accountId: "ira",
        contribution: 50000,
        currentTotal: 1000000,
        finalTotal: 1050000,
        positions: [{ fundId: "vti", currentValue: 600000, tradeDelta: 0, finalValue: 600000 }],
      },
    ],
  };
  render(<ResultView scenario={scenario} result={untouched} />);

  expect(screen.getByText("No trades needed — every asset class is within its tolerance band.")).toBeInTheDocument();
  const accounts = screen.getByRole("region", { name: "Accounts" });
  const vtiRow = within(accounts).getByRole("row", { name: /VTI/ });
  expect(within(vtiRow).getByText("—")).toBeInTheDocument();
  expect(within(accounts).getByText(/\+\$500\.00 cash in/)).toBeInTheDocument();
});

test("renders warnings as an alert when present, and no alert otherwise", () => {
  const { rerender } = render(<ResultView scenario={scenario} result={result} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  const warned: RebalanceResult = { ...result, warnings: ["US Bonds cannot be reached: no funded account offers it."] };
  rerender(<ResultView scenario={scenario} result={warned} />);
  expect(screen.getByRole("alert")).toHaveTextContent("US Bonds cannot be reached");
});

test("integration: renders a real solver result for the demo scenario", () => {
  const real = rebalance(demoScenario.portfolio, demoScenario.targets, {
    ...demoScenario.options,
    contributions: demoScenario.contributions,
  });
  render(<ResultView scenario={demoScenario} result={real} />);

  // The demo scenario contributes $600 total, all of which must be invested.
  expect(screen.getByRole("region", { name: "Trades" })).toBeInTheDocument();
  expect(screen.getAllByText("BUY").length).toBeGreaterThan(0);
  expect(screen.getByRole("region", { name: "Portfolio by asset class" })).toBeInTheDocument();
});
