import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "./App.tsx";
import { demoScenario } from "./demo-scenario.ts";

test("renders a populated scenario's solved result", () => {
  render(<App initialScenario={demoScenario} />);
  expect(screen.getByRole("heading", { name: "rebalancetool" })).toBeInTheDocument();
  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getAllByText("BUY").length).toBeGreaterThan(0);
  expect(screen.getByRole("region", { name: "Portfolio by asset class" })).toBeInTheDocument();
});

test("the compliance disclaimer footer is always present", () => {
  render(<App initialScenario={demoScenario} />);
  const footer = screen.getByRole("contentinfo");
  expect(footer).toHaveTextContent("This is a calculator, not investment advice.");
  expect(footer).toHaveTextContent(
    "the funds pre-loaded on first visit are editable placeholders for convenience, not recommendations",
  );
  expect(footer).toHaveTextContent("Your data stays in your browser and is never transmitted or stored by this site.");
});

test("breaking the targets total replaces results with an error, fixing it brings them back", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  const usStocks = screen.getByLabelText("Target weight for US Stocks");
  await user.clear(usStocks);
  await user.type(usStocks, "50");

  // 50 + 20 + 20 + 10 + 10 = 110% — the indicator and the solver both object.
  expect(screen.getByText(/must total 100%/)).toHaveTextContent("110% — must total 100%");
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Can’t rebalance yet");
  expect(screen.queryByRole("region", { name: "Trades" })).not.toBeInTheDocument();

  await user.clear(usStocks);
  await user.type(usStocks, "40");
  // (The demo scenario's own warning alert is still there; only the solve error must be gone.)
  expect(screen.queryByText("Can’t rebalance yet")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Trades" })).toBeInTheDocument();
});

test("a contribution row added from the picker feeds the solver; its ✕ clears it", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  // Roth IRA has no contribution in the demo, so the row starts hidden.
  expect(screen.queryByLabelText("Cash to invest in Roth IRA")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Add to Roth IRA"), "__cash__");

  const rothContribution = screen.getByLabelText("Cash to invest in Roth IRA");
  await user.type(rothContribution, "1000");

  const accounts = () => screen.getByRole("region", { name: "Accounts" });
  expect(within(accounts()).getByText(/\+\$1,000\.00 cash in/)).toBeInTheDocument();

  await user.click(screen.getByLabelText("Remove cash to invest from Roth IRA"));
  expect(screen.queryByLabelText("Cash to invest in Roth IRA")).not.toBeInTheDocument();
  expect(within(accounts()).queryByText(/\+\$1,000\.00 cash in/)).not.toBeInTheDocument();
});

test("the app starts with the fund catalog only: no accounts, targets, or amounts", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Start with your portfolio" })).toBeInTheDocument();
  expect(screen.queryByText("Can’t rebalance yet")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Trades" })).not.toBeInTheDocument();

  // The starter catalog is present — including VT as a ready-made blend...
  expect(screen.getByLabelText("Ticker for fund vti")).toHaveValue("VTI");
  expect(screen.getByRole("button", { name: "Asset class blend for VT" })).toHaveAttribute(
    "title",
    "65% US Stocks · 35% International Stocks",
  );
  // ...but nothing that could read as a suggested portfolio: every target
  // percentage is blank and no account exists.
  expect(screen.getByLabelText("Target weight for US Stocks")).toHaveValue("");
  expect(screen.getByLabelText("Target weight for US Bonds")).toHaveValue("");
  expect(screen.queryByLabelText(/Account name/)).not.toBeInTheDocument();
});

test("Clear all wipes everything back to the getting-started card", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  await user.click(screen.getByRole("button", { name: "Clear all" }));
  expect(screen.getByRole("heading", { name: "Start with your portfolio" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Target weight for US Stocks")).not.toBeInTheDocument();
});

test("a portfolio built from scratch in the UI produces trades", async () => {
  const user = userEvent.setup();
  render(<App />);

  // Wipe the starter catalog to prove the whole flow works from nothing.
  await user.click(screen.getByRole("button", { name: "Clear all" }));

  // Build: one asset class, one fund, one tax-deferred account holding $900.
  await user.type(screen.getByLabelText("New asset class name"), "US Stocks");
  await user.click(screen.getByRole("button", { name: "Add class" }));

  await user.type(screen.getByLabelText("New fund ticker"), "vti");
  await user.click(screen.getByRole("button", { name: "Add fund" }));

  await user.type(screen.getByLabelText("New account name"), "My IRA");
  await user.selectOptions(screen.getByLabelText("Tax type for new account"), "tax_deferred");
  await user.click(screen.getByRole("button", { name: "Add account" }));

  await user.selectOptions(screen.getByLabelText("Add to My IRA"), "vti");
  await user.type(screen.getByLabelText("Current value of VTI in My IRA"), "900");

  // Plan: 100% US Stocks, $100 contribution (added via the same picker).
  await user.type(screen.getByLabelText("Target weight for US Stocks"), "100");
  await user.selectOptions(screen.getByLabelText("Add to My IRA"), "__cash__");
  await user.type(screen.getByLabelText("Cash to invest in My IRA"), "100");

  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getByText("BUY")).toBeInTheDocument();
  expect(within(trades).getByText("$100.00")).toBeInTheDocument();
  expect(within(trades).getByRole("heading", { name: /My IRA/ })).toBeInTheDocument();
});

test("uploading a scenario JSON file replaces the state", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  const uploaded = {
    portfolio: {
      assetClasses: [{ id: "stocks", name: "Stocks" }],
      funds: [{ id: "swtsx", ticker: "SWTSX", name: "Schwab Total Stock Market", assetClasses: { "stocks": 10000 } }],
      accounts: [
        { id: "solo401k", name: "Solo 401(k)", taxType: "tax_deferred" as const, availableFundIds: ["swtsx"] },
      ],
      holdings: [{ accountId: "solo401k", fundId: "swtsx", value: 100000 }],
    },
    targets: [{ assetClassId: "stocks", weight: 10000 }],
    contributions: [{ accountId: "solo401k", amount: 5000 }],
  };
  const file = new File([JSON.stringify(uploaded)], "scenario.json", { type: "application/json" });
  await user.upload(screen.getByLabelText("Open scenario file"), file);

  expect(await screen.findByLabelText("Account name (solo401k)")).toHaveValue("Solo 401(k)");
  const trades = screen.getByRole("region", { name: "Trades" });
  expect(within(trades).getByText("$50.00")).toBeInTheDocument();
});

test("uploading a broken file shows an error and keeps the current scenario", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  const file = new File(["{ not json"], "broken.json", { type: "application/json" });
  await user.upload(screen.getByLabelText("Open scenario file"), file);

  expect(await screen.findByText("Couldn’t load that file")).toBeInTheDocument();
  expect(screen.getByText("That file isn't valid JSON.")).toBeInTheDocument();
  // The demo scenario is still on screen.
  expect(screen.getByLabelText("Target weight for US Stocks")).toBeInTheDocument();
});

test("removing a fund from an account clears its menu entry and holding, and it becomes addable again", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  // VXUS is in the taxable account's menu (so not in its add picker) and holds $8,000.
  const addPicker = () => screen.getByLabelText("Add to Taxable Brokerage");
  expect(within(addPicker()).queryByRole("option", { name: /VXUS/ })).not.toBeInTheDocument();

  await user.click(screen.getByLabelText("Remove VXUS from Taxable Brokerage"));

  expect(screen.queryByLabelText("Current value of VXUS in Taxable Brokerage")).not.toBeInTheDocument();
  expect(within(addPicker()).getByRole("option", { name: /VXUS/ })).toBeInTheDocument();
  // The holding is gone too: all that remains of International Stocks is the
  // 35% slice of the HSA's $2,000 VT blend.
  const allocation = screen.getByRole("region", { name: "Portfolio by asset class" });
  const intlRow = within(allocation).getByRole("row", { name: /International Stocks/ });
  expect(within(intlRow).getAllByText("$700.00").length).toBeGreaterThan(0);
});

test("the demo's VT blend shows a Blend toggle in the Funds card and is editable slice by slice", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  // Collapsed: a compact "Blend" toggle whose tooltip carries the mix.
  const summary = screen.getByRole("button", { name: "Asset class blend for VT" });
  expect(summary).toHaveTextContent("Blend");
  expect(summary).toHaveAttribute("title", "65% US Stocks · 35% International Stocks");

  await user.click(summary);
  const usWeight = screen.getByLabelText("Weight of US Stocks in VT");
  expect(usWeight).toHaveValue("65");

  // Nudge the split to 60/40 and watch the tooltip follow.
  await user.clear(usWeight);
  await user.type(usWeight, "60");
  await user.clear(screen.getByLabelText("Weight of International Stocks in VT"));
  await user.type(screen.getByLabelText("Weight of International Stocks in VT"), "40");
  expect(screen.getByRole("button", { name: "Asset class blend for VT" })).toHaveAttribute(
    "title",
    "60% US Stocks · 40% International Stocks",
  );
});

test("a new fund can be added as a blend straight from the add row", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  await user.type(screen.getByLabelText("New fund ticker"), "aoa");
  await user.selectOptions(screen.getByLabelText("Asset class for new fund"), "__blend__");
  await user.click(screen.getByRole("button", { name: "Add fund" }));

  // The fund arrives as 100% of the first class with its slice editor
  // already open, ready to be carved up.
  expect(screen.getByRole("button", { name: "Asset class blend for AOA" })).toHaveAttribute("title", "100% US Stocks");
  expect(screen.getByLabelText("Weight of US Stocks in AOA")).toHaveValue("100");
  expect(screen.getByLabelText("Add asset class to AOA")).toBeInTheDocument();
});

test("the add row refuses a duplicate ticker outright", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  await user.type(screen.getByLabelText("New fund ticker"), "vti");
  expect(screen.getByRole("button", { name: "Add fund" })).toBeDisabled();
  expect(screen.getByText("VTI is already in the fund list.")).toBeInTheDocument();

  // A fresh ticker re-enables the button.
  await user.clear(screen.getByLabelText("New fund ticker"));
  await user.type(screen.getByLabelText("New fund ticker"), "schb");
  expect(screen.getByRole("button", { name: "Add fund" })).toBeEnabled();
});

test("the add rows refuse duplicate class and account names, case-insensitively", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  await user.type(screen.getByLabelText("New asset class name"), "US Stocks");
  expect(screen.getByRole("button", { name: "Add class" })).toBeDisabled();
  expect(screen.getByText('An asset class named "US Stocks" already exists.')).toBeInTheDocument();

  await user.type(screen.getByLabelText("New account name"), "hsa");
  expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
  expect(screen.getByText('An account named "hsa" already exists.')).toBeInTheDocument();
});

test("editing an existing fund's ticker into a collision surfaces the solver's error until fixed", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  const vxusTicker = screen.getByLabelText("Ticker for fund vxus");
  await user.clear(vxusTicker);
  await user.type(vxusTicker, "VTI");

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Can’t rebalance yet");
  expect(alert).toHaveTextContent('both have ticker "VTI"');

  await user.clear(vxusTicker);
  await user.type(vxusTicker, "VXUS");
  expect(screen.queryByText("Can’t rebalance yet")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Trades" })).toBeInTheDocument();
});

test("a single-class fund becomes a blend through the 'Blend of classes…' picker", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  // VTI starts as a plain class dropdown; choosing the blend option opens
  // the slice editor without changing the data (100% US Stocks).
  await user.selectOptions(screen.getByLabelText("Asset class for fund VTI"), "__blend__");
  expect(screen.getByLabelText("Weight of US Stocks in VTI")).toHaveValue("100");

  // Add a bonds slice; it pre-fills with the weight missing from 100% —
  // zero here, which renders as an empty field like every zero amount.
  await user.selectOptions(screen.getByLabelText("Add asset class to VTI"), "us_bonds");
  const bondsWeight = screen.getByLabelText("Weight of US Bonds in VTI");
  expect(bondsWeight).toHaveValue("");

  // An off-100% blend total is flagged, and the solver refuses in place.
  await user.clear(bondsWeight);
  await user.type(bondsWeight, "10");
  expect(screen.getByText(/blend total/)).toHaveTextContent("must total 100%");
  expect(screen.getByRole("alert")).toHaveTextContent("Can’t rebalance yet");

  // Fix the US slice to 90% and results come back.
  const usWeight = screen.getByLabelText("Weight of US Stocks in VTI");
  await user.clear(usWeight);
  await user.type(usWeight, "90");
  expect(screen.queryByText("Can’t rebalance yet")).not.toBeInTheDocument();

  // Removing the bonds slice bumps US back to 100% and the row collapses
  // back to a plain dropdown once the editor is closed.
  await user.click(screen.getByLabelText("Remove US Bonds from VTI"));
  expect(screen.getByLabelText("Weight of US Stocks in VTI")).toHaveValue("100");
  await user.click(screen.getByRole("button", { name: "Asset class blend for VTI" }));
  expect(screen.getByLabelText("Asset class for fund VTI")).toHaveValue("us_stocks");
});

test("fund preference order can be changed from the drag handle's keyboard mode", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  // Taxable Brokerage menu is VTI #1, VXUS #2.
  const handle = screen.getByLabelText("Reorder VXUS in Taxable Brokerage (position 2)");
  handle.focus();
  await user.keyboard(" "); // lift
  await user.keyboard("{ArrowUp}");
  await user.keyboard(" "); // drop

  expect(screen.getByLabelText("Reorder VXUS in Taxable Brokerage (position 1)")).toBeInTheDocument();
  expect(screen.getByLabelText("Reorder VTI in Taxable Brokerage (position 2)")).toBeInTheDocument();
});

test("selling is on by default; turning it off in Settings removes sells and flags it", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  const trades = () => screen.getByRole("region", { name: "Trades" });
  expect(within(trades()).getAllByText("SELL").length).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: /Settings/ }));
  await user.click(screen.getByLabelText("Allow selling"));

  expect(within(trades()).queryAllByText("SELL")).toHaveLength(0);
  // Tucked-away settings must never invisibly shape results.
  expect(within(trades()).getByText(/selling off/)).toBeInTheDocument();
});

test("taxable sells are on by default; unchecking the checkbox protects taxable accounts", async () => {
  const user = userEvent.setup();
  render(<App initialScenario={demoScenario} />);

  const trades = () => screen.getByRole("region", { name: "Trades" });
  const taxableTradeCard = () =>
    within(trades()).queryByRole("heading", { name: /Taxable Brokerage/ })?.closest(".card") as HTMLElement | null;
  // The drifted demo portfolio uses a taxable sell out of the box.
  expect(within(taxableTradeCard()!).getAllByText("SELL").length).toBeGreaterThan(0);

  await user.click(screen.getByLabelText("Allow selling in taxable accounts"));

  expect(taxableTradeCard() === null || within(taxableTradeCard()!).queryAllByText("SELL").length === 0).toBe(true);
});
