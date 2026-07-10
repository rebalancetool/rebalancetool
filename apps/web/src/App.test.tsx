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

test("allow selling produces sell trades for the drifted demo portfolio", async () => {
  const user = userEvent.setup();
  render(<App />);

  const trades = () => screen.getByRole("region", { name: "Trades" });
  expect(within(trades()).queryAllByText("SELL")).toHaveLength(0);

  await user.click(screen.getByLabelText(/Allow selling/));
  expect(within(trades()).getAllByText("SELL").length).toBeGreaterThan(0);
});
