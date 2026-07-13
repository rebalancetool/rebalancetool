import { rebalance } from "@rebalancer/solver";
import type { RebalanceResult, Scenario } from "@rebalancer/solver";
import { useEffect, useMemo, useRef, useState } from "react";
import { PortfolioEditor } from "./PortfolioEditor.tsx";
import { ResultView } from "./ResultView.tsx";
import { emptyScenario, withOptions } from "./scenario-edit.ts";
import { scenarioFromJson, scenarioToJson } from "./scenario-file.ts";
import { starterScenario } from "./starter-scenario.ts";
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

/**
 * A brief "Recomputing…" pulse above the results on every scenario change.
 * The solver is synchronous — results are already current by the time this
 * renders — so the pulse is purely perceptual: an edit whose recomputed
 * output happens to look identical to the previous one still visibly did
 * something. Not a live region: announcing every keystroke would drown
 * screen readers, and the results themselves are the real signal.
 */
function RecomputeStatus({ scenario }: { scenario: Scenario }) {
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    setBusy(true);
    const timer = setTimeout(() => setBusy(false), 500);
    return () => clearTimeout(timer);
  }, [scenario]);
  return (
    <div className="recompute-status">
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" />
          Recomputing…
        </>
      ) : (
        <>
          <span className="status-check" aria-hidden="true">
            ✓
          </span>
          Up to date
        </>
      )}
    </div>
  );
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

/**
 * `initialScenario` exists for tests (which drive a populated portfolio);
 * the shipped app starts with only the starter fund catalog — no accounts,
 * holdings, or targets. Pre-filling those could read as a suggested
 * portfolio; the compliance posture is that every number on screen was
 * stated by the user.
 */
export function App({ initialScenario }: { initialScenario?: Scenario } = {}) {
  const [scenario, setScenario] = useState<Scenario>(initialScenario ?? starterScenario());
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
            <h1>
              <img className="wordmark" src="/wordmark.svg" alt="rebalancetool" height={48} />
            </h1>
            <p className="tagline">
              See the exact trades that rebalance your whole portfolio toward your targets —
              every account at once, tax-aware, right in your browser.
            </p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              title="Download your whole setup as a file you can open again later"
              onClick={() => downloadScenario(scenario)}
            >
              Save file
            </button>
            <button
              type="button"
              title="Open a previously saved file"
              onClick={() => fileInput.current?.click()}
            >
              Open file…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              aria-label="Open scenario file"
              className="visually-hidden"
              onChange={(event) => {
                void onFileChosen(event.target.files?.[0]);
                event.target.value = ""; // so picking the same file again re-fires
              }}
            />
            <button type="button" onClick={() => setScenario(emptyScenario())}>
              Clear all
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

        {scenario.portfolio.accounts.length > 0 && <RecomputeStatus scenario={scenario} />}

        {scenario.portfolio.accounts.length === 0 ? (
          // Until an account exists nothing can be computed: show guidance,
          // not the solver's error.
          <div className="card get-started">
            <h3>Build your portfolio</h3>
            <ul>
              <li>
                The funds and asset classes above are a pre-loaded starting point.
                They're placeholders, not recommendations, and you can rename, replace or remove them.
              </li>
              <li>Set each asset class's target percentage, then add your accounts with their current balances.</li>
              <li>
                In each account add all funds that you can trade in the account. To prefer trading a specific fund
                in an account, order it higher.
              </li>
              <li>The trades that move your portfolio toward your targets will appear below.</li>
            </ul>
            <p>
              You can open a previously saved file with <strong>Open file…</strong>
            </p>
          </div>
        ) : outcome.result ? (
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
          accounts may hold them. The tool computes trades that move your stated holdings toward your stated
          targets. It does not recommend any security, allocation, or strategy. The funds pre-loaded on
          first visit are editable placeholders for convenience, not recommendations. Nothing here is
          investment, tax, or legal advice. Consult a qualified professional before making investment
          decisions.
        </p>
        <p>
          Your data stays in your browser and is never transmitted or stored by this site. Reloading
          clears the page — use <strong>Save file</strong> to keep your work.
        </p>
      </footer>
    </div>
  );
}
