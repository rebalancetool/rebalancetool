import { DEFAULT_TOLERANCE_BPS } from "@rebalancer/solver";
import type { Scenario } from "@rebalancer/solver";
import { MoneyInput, PercentInput } from "./inputs.tsx";
import { withOptions } from "./scenario-edit.ts";

/**
 * The options editor. It edits the options slice of the Scenario via the
 * pure updaters in scenario-edit.ts and reports the whole new Scenario up —
 * the solver run happens in App. (Targets are edited in the Asset classes
 * card; contributions in each account card.)
 */

interface EditorProps {
  scenario: Scenario;
  onChange: (scenario: Scenario) => void;
}

export function OptionsEditor({ scenario, onChange }: EditorProps) {
  const options = scenario.options ?? {};
  return (
    <div className="card editor-card">
      <h3>Settings</h3>
      <label className="check-row">
        <input
          type="checkbox"
          aria-label="Allow selling"
          checked={options.allowSelling ?? false}
          onChange={(event) => onChange(withOptions(scenario, { allowSelling: event.target.checked }))}
        />
        <span>
          Allow selling
          <span className="editor-hint">Rotate overweight positions into underweight ones.</span>
        </span>
      </label>
      <label className="check-row check-row-nested">
        <input
          type="checkbox"
          aria-label="Allow selling in taxable accounts"
          checked={options.sellInTaxableAccounts ?? false}
          onChange={(event) => onChange(withOptions(scenario, { sellInTaxableAccounts: event.target.checked }))}
        />
        <span>
          Allow selling in taxable accounts
          <span className="editor-hint">
            Sells there can realize capital gains. Off = rebalance only tax-advantaged accounts by selling.
          </span>
        </span>
      </label>
      <label className="check-row check-row-nested">
        <input
          type="checkbox"
          aria-label="Optimize asset location"
          checked={options.optimizeAssetLocation ?? false}
          onChange={(event) => onChange(withOptions(scenario, { optimizeAssetLocation: event.target.checked }))}
        />
        <span>
          Optimize asset location
          <span className="editor-hint">
            Relocate asset classes into the account types their tax preference names, even when the allocation is
            already on target. Moving a class out of a taxable account also needs taxable selling.
          </span>
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
    </div>
  );
}
