import { DEFAULT_TOLERANCE_BPS, TOTAL_BPS } from "@rebalancer/solver";
import type { Scenario } from "@rebalancer/solver";
import { formatBpsAsPercent } from "./format.ts";
import { MoneyInput, PercentInput } from "./inputs.tsx";
import { targetWeightTotal, withContribution, withOptions, withTargetWeight } from "./scenario-edit.ts";

/**
 * The targets / contributions / options editors. Each edits one slice of
 * the Scenario via the pure updaters in scenario-edit.ts and reports the
 * whole new Scenario up — the solver run happens in App.
 */

interface EditorProps {
  scenario: Scenario;
  onChange: (scenario: Scenario) => void;
}

export function TargetsEditor({ scenario, onChange }: EditorProps) {
  const total = targetWeightTotal(scenario);
  const weightByClassId = new Map(scenario.targets.map((t) => [t.assetClassId, t.weight]));
  return (
    <div className="card editor-card">
      <h3>Targets</h3>
      <p className="editor-hint">Desired share of the whole portfolio, per asset class.</p>
      {scenario.portfolio.assetClasses.map((assetClass) => (
        <div className="field-row" key={assetClass.id}>
          <span className="field-label">{assetClass.name}</span>
          <PercentInput
            bps={weightByClassId.get(assetClass.id) ?? 0}
            onBps={(weight) => onChange(withTargetWeight(scenario, assetClass.id, weight))}
            label={`Target weight for ${assetClass.name}`}
          />
        </div>
      ))}
      <div className={`field-row total-line ${total === TOTAL_BPS ? "total-ok" : "total-bad"}`} role="status">
        <span className="field-label">Total</span>
        <span className="num">
          {formatBpsAsPercent(total)}
          {total !== TOTAL_BPS && " — must total 100%"}
        </span>
      </div>
    </div>
  );
}

export function ContributionsEditor({ scenario, onChange }: EditorProps) {
  const amountByAccountId = new Map(scenario.contributions.map((c) => [c.accountId, c.amount]));
  return (
    <div className="card editor-card">
      <h3>Contributions</h3>
      <p className="editor-hint">New cash to invest, per account. Money never moves between accounts.</p>
      {scenario.portfolio.accounts.map((account) => (
        <div className="field-row" key={account.id}>
          <span className="field-label">{account.name}</span>
          <MoneyInput
            cents={amountByAccountId.get(account.id) ?? 0}
            onCents={(amount) => onChange(withContribution(scenario, account.id, amount))}
            label={`Contribution to ${account.name}`}
          />
        </div>
      ))}
    </div>
  );
}

export function OptionsEditor({ scenario, onChange }: EditorProps) {
  const options = scenario.options ?? {};
  return (
    <div className="card editor-card">
      <h3>Options</h3>
      <label className="check-row">
        <input
          type="checkbox"
          checked={options.allowSelling ?? false}
          onChange={(event) => onChange(withOptions(scenario, { allowSelling: event.target.checked }))}
        />
        <span>
          Allow selling
          <span className="editor-hint">Rotate overweight positions into underweight ones.</span>
        </span>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={options.sellInTaxableAccounts ?? false}
          onChange={(event) => onChange(withOptions(scenario, { sellInTaxableAccounts: event.target.checked }))}
        />
        <span>
          Sell in taxable accounts
          <span className="editor-hint">May realize capital gains; implies selling.</span>
        </span>
      </label>
      <div className="field-row">
        <span className="field-label">
          Tolerance band
          <span className="editor-hint">Classes within ± this of target are left alone.</span>
        </span>
        <PercentInput
          bps={options.toleranceBps ?? DEFAULT_TOLERANCE_BPS}
          onBps={(toleranceBps) => onChange(withOptions(scenario, { toleranceBps }))}
          label="Tolerance band"
        />
      </div>
      <div className="field-row">
        <span className="field-label">
          Minimum sell-funded trade
          <span className="editor-hint">Smaller sells are skipped; contributions always invest fully.</span>
        </span>
        <MoneyInput
          cents={options.minTradeCents ?? 0}
          onCents={(minTradeCents) => onChange(withOptions(scenario, { minTradeCents }))}
          label="Minimum sell-funded trade"
        />
      </div>
      <div className="field-row">
        <span className="field-label">Optimizer</span>
        <select
          aria-label="Optimizer"
          value={options.optimizer ?? "lp"}
          onChange={(event) =>
            onChange(withOptions(scenario, { optimizer: event.target.value === "greedy" ? "greedy" : "lp" }))
          }
        >
          <option value="lp">LP (optimal)</option>
          <option value="greedy">Greedy waterfall</option>
        </select>
      </div>
    </div>
  );
}
