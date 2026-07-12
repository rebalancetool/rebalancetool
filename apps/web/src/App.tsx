import { rebalance } from "@rebalancer/solver";
import type { RebalanceResult, Scenario } from "@rebalancer/solver";
import { useMemo, useRef, useState } from "react";
import { demoScenario } from "./demo-scenario.ts";
import { PortfolioEditor } from "./PortfolioEditor.tsx";
import { ResultView } from "./ResultView.tsx";
import { emptyScenario, withOptions } from "./scenario-edit.ts";
import { scenarioFromJson, scenarioToJson } from "./scenario-file.ts";
import { OptionsEditor } from "./ScenarioEditor.tsx";

type Outcome = { result: RebalanceResult; error?: undefined } | { result?: undefined; error: string };

/** The one place the solver runs. Invalid input renders as a message, not a crash. */
function solve(scenario: Scenario): Outcome {
  try {
    return {
      result: rebalance(scenario.portfolio, scenario.targets, {
        ...scenario.options,
        contributions: scenario.contributions,
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Hand the browser a file to save. DOM-only glue; the content comes from scenario-file.ts. */
function downloadScenario(scenario: Scenario): void {
  const url = URL.createObjectURL(new Blob([scenarioToJson(scenario)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "rebalancer-scenario.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const [scenario, setScenario] = useState<Scenario>(demoScenario);
  const [fileError, setFileError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const outcome = useMemo(() => solve(scenario), [scenario]);
  const allowTaxableSells = scenario.options?.sellInTaxableAccounts ?? false;

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      setScenario(scenarioFromJson(await file.text()));
      setFileError(null);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="app">
      <main>
        <header className="app-header">
          <div>
            <h1>Asset Allocation Rebalance Calculator</h1>
            <p className="tagline">
              Multi-account portfolio rebalancing. Everything runs in this page —
              nothing is uploaded, and reloading clears it.
            </p>
          </div>
          <div className="header-actions">
            <button type="button" onClick={() => downloadScenario(scenario)}>
              Download JSON
            </button>
            <button type="button" onClick={() => fileInput.current?.click()}>
              Load JSON…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              aria-label="Load scenario JSON file"
              className="visually-hidden"
              onChange={(event) => {
                void onFileChosen(event.target.files?.[0]);
                event.target.value = ""; // so picking the same file again re-fires
              }}
            />
            <button type="button" onClick={() => setScenario(demoScenario)}>
              Load example
            </button>
            <button type="button" onClick={() => setScenario(emptyScenario())}>
              Start empty
            </button>
            <div className="settings-anchor">
              <button
                type="button"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                ⚙ Settings
              </button>
              {settingsOpen && (
                <div
                  className="settings-popover"
                  role="dialog"
                  aria-label="Settings"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setSettingsOpen(false);
                  }}
                >
                  <OptionsEditor scenario={scenario} onChange={setScenario} />
                </div>
              )}
            </div>
          </div>
        </header>

        <label className="check-row taxable-guard">
          <input
            type="checkbox"
            aria-label="Allow selling in taxable accounts"
            checked={allowTaxableSells}
            onChange={(event) => setScenario(withOptions(scenario, { sellInTaxableAccounts: event.target.checked }))}
          />
          <span>
            Allow selling in taxable accounts
            <span className="editor-hint">
              Sells there can realize capital gains — uncheck to rebalance only tax-advantaged accounts by selling.
            </span>
          </span>
        </label>

        {fileError && (
          <div className="card solve-error" role="alert">
            <h3>Couldn’t load that file</h3>
            <p>{fileError}</p>
          </div>
        )}

        <PortfolioEditor scenario={scenario} onChange={setScenario} />

        {outcome.result ? (
          <ResultView scenario={scenario} result={outcome.result} />
        ) : (
          <div className="card solve-error" role="alert">
            <h3>Can’t rebalance yet</h3>
            <p>{outcome.error}</p>
          </div>
        )}
      </main>

      {/* Compliance disclaimer — this must stay visible on every layout. The
          tool must present itself as impersonal arithmetic on user-supplied
          inputs, never as personalized securities advice. */}
      <footer className="app-footer">
        <p>
          <strong>This is a calculator, not investment advice.</strong> This tool performs arithmetic on
          information you provide. You choose the asset classes, the target allocation, the funds, and which
          accounts may hold them; the tool computes trades that move your stated holdings toward your stated
          targets. It does not recommend any security, allocation, or strategy, and the example data shown
          before you enter your own is illustrative only — not a suggested portfolio. Nothing here is
          investment, tax, or legal advice. Consult a qualified professional before making investment
          decisions.
        </p>
        <p>Your data stays in your browser and is never transmitted or stored by this site.</p>
      </footer>
    </div>
  );
}
