import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "./App.tsx";

test("renders the demo scenario's solved result on load", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Rebalancer" })).toBeInTheDocument();
  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getAllByText("BUY").length).toBeGreaterThan(0);
  expect(screen.getByRole("region", { name: "Portfolio by asset class" })).toBeInTheDocument();
});

test("breaking the targets total replaces results with an error, fixing it brings them back", async () => {
  const user = userEvent.setup();
  render(<App />);

  const usStocks = screen.getByLabelText("Target weight for US Stocks");
  await user.clear(usStocks);
  await user.type(usStocks, "50");

  // 50 + 20 + 20 + 10 + 10 = 110% — the indicator and the solver both object.
  expect(screen.getByRole("status")).toHaveTextContent("110% — must total 100%");
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Can’t rebalance yet");
  expect(screen.queryByRole("region", { name: "Trades" })).not.toBeInTheDocument();

  await user.clear(usStocks);
  await user.type(usStocks, "40");
  // (The demo scenario's own warning alert is still there; only the solve error must be gone.)
  expect(screen.queryByText("Can’t rebalance yet")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Trades" })).toBeInTheDocument();
});

test("typing a contribution feeds the solver and shows up in the account breakdown", async () => {
  const user = userEvent.setup();
  render(<App />);

  const rothContribution = screen.getByLabelText("Contribution to Roth IRA");
  await user.clear(rothContribution);
  await user.type(rothContribution, "1000");

  const accounts = screen.getByRole("region", { name: "Accounts" });
  expect(within(accounts).getByText(/\+\$1,000\.00 cash in/)).toBeInTheDocument();
});

test("a portfolio built from scratch in the UI produces trades", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Start empty" }));
  expect(screen.getByText("Can’t rebalance yet")).toBeInTheDocument();

  // Build: one asset class, one fund, one tax-deferred account holding $900.
  await user.type(screen.getByLabelText("New asset class name"), "US Stocks");
  await user.click(screen.getByRole("button", { name: "Add class" }));

  await user.type(screen.getByLabelText("New fund ticker"), "vti");
  await user.click(screen.getByRole("button", { name: "Add fund" }));

  await user.type(screen.getByLabelText("New account name"), "My IRA");
  await user.selectOptions(screen.getByLabelText("Tax type for new account"), "tax_deferred");
  await user.click(screen.getByRole("button", { name: "Add account" }));

  await user.click(screen.getByLabelText("VTI buyable in My IRA"));
  await user.type(screen.getByLabelText("Current value of VTI in My IRA"), "900");

  // Plan: 100% US Stocks, $100 contribution.
  await user.type(screen.getByLabelText("Target weight for US Stocks"), "100");
  await user.type(screen.getByLabelText("Contribution to My IRA"), "100");

  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getByText("BUY")).toBeInTheDocument();
  expect(within(trades).getByText("$100.00")).toBeInTheDocument();
  expect(within(trades).getByRole("heading", { name: /My IRA/ })).toBeInTheDocument();
});

test("uploading a scenario JSON file replaces the state", async () => {
  const user = userEvent.setup();
  render(<App />);

  const uploaded = {
    portfolio: {
      assetClasses: [{ id: "stocks", name: "Stocks" }],
      funds: [{ id: "swtsx", ticker: "SWTSX", name: "Schwab Total Stock Market", assetClassId: "stocks" }],
      accounts: [
        { id: "solo401k", name: "Solo 401(k)", taxType: "tax_deferred" as const, availableFundIds: ["swtsx"] },
      ],
      holdings: [{ accountId: "solo401k", fundId: "swtsx", value: 100000 }],
    },
    targets: [{ assetClassId: "stocks", weight: 10000 }],
    contributions: [{ accountId: "solo401k", amount: 5000 }],
  };
  const file = new File([JSON.stringify(uploaded)], "scenario.json", { type: "application/json" });
  await user.upload(screen.getByLabelText("Load scenario JSON file"), file);

  expect(await screen.findByLabelText("Account name (solo401k)")).toHaveValue("Solo 401(k)");
  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getByText("$50.00")).toBeInTheDocument();
});

test("uploading a broken file shows an error and keeps the current scenario", async () => {
  const user = userEvent.setup();
  render(<App />);

  const file = new File(["{ not json"], "broken.json", { type: "application/json" });
  await user.upload(screen.getByLabelText("Load scenario JSON file"), file);

  expect(await screen.findByText("Couldn’t load that file")).toBeInTheDocument();
  expect(screen.getByText("That file isn't valid JSON.")).toBeInTheDocument();
  // The demo scenario is still on screen.
  expect(screen.getByLabelText("Target weight for US Stocks")).toBeInTheDocument();
});

test("allow selling produces sell trades for the drifted demo portfolio", async () => {
  const user = userEvent.setup();
  render(<App />);

  const trades = () => screen.getByRole("region", { name: "Trades" });
  expect(within(trades()).queryAllByText("SELL")).toHaveLength(0);

  await user.click(screen.getByLabelText(/Allow selling/));
  expect(within(trades()).getAllByText("SELL").length).toBeGreaterThan(0);
});
