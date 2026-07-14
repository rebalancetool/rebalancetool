import { rebalance } from "@rebalancer/solver";
import type { RebalanceResult, Scenario } from "@rebalancer/solver";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeOptions } from "./format.ts";
import { PortfolioEditor } from "./PortfolioEditor.tsx";
import { ResultView } from "./ResultView.tsx";
import { emptyScenario } from "./scenario-edit.ts";
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
 * The ⚙ Settings button with its anchored popover. Two placements — the
 * header and the status bar — each own their instance; the scenario they
 * edit is shared, so only the open/closed state is per-placement.
 */
function SettingsButton({
  scenario,
  onChange,
  popoverSide = "right",
  label,
}: {
  scenario: Scenario;
  onChange: (scenario: Scenario) => void;
  popoverSide?: "left" | "right";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-anchor">
      <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen((wasOpen) => !wasOpen)}>
        ⚙ Settings
      </button>
      {open && (
        <div
          className={`settings-popover${popoverSide === "left" ? " settings-popover-left" : ""}`}
          role="dialog"
          aria-label="Settings"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <OptionsEditor scenario={scenario} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/**
 * The status bar between the editor and the results: the recompute pulse,
 * the settings summary (selling posture always, other knobs when
 * non-default — see describeOptions), and its own ⚙ Settings button, so the
 * settings that shape the results are stated and adjustable right where the
 * results begin.
 *
 * The pulse: the solver is synchronous — results are already current by the
 * time this renders — so it is purely perceptual: an edit whose recomputed
 * output happens to look identical to the previous one still visibly did
 * something. Not a live region: announcing every keystroke would drown
 * screen readers, and the results themselves are the real signal.
 */
function StatusBar({ scenario, onChange }: { scenario: Scenario; onChange: (scenario: Scenario) => void }) {
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    setBusy(true);
    const timer = setTimeout(() => setBusy(false), 500);
    return () => clearTimeout(timer);
  }, [scenario]);
  return (
    <div className="status-bar">
      <span className="recompute-status">
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
      </span>
      <span className="status-options">{describeOptions(scenario.options)}</span>
      <SettingsButton scenario={scenario} onChange={onChange} popoverSide="left" label="Rebalance settings" />
    </div>
  );
}

/** Hand the browser a file to save. DOM-only glue; the content comes from scenario-file.ts. */
function downloadScenario(scenario: Scenario): void {
  const url = URL.createObjectURL(new Blob([scenarioToJson(scenario)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "rebalancetool.json";
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
  const fileInput = useRef<HTMLInputElement>(null);
  const outcome = useMemo(() => solve(scenario), [scenario]);

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
            <div className="tagline">
              <p className="how-title">How it works:</p>
              <ol className="how-steps">
                <li>Choose a target asset allocation.</li>
                <li>Enter your current investments and the funds each account can trade.</li>
                <li>
                  See the trades that reach your targets: all your accounts, tax-aware, and no
                  unnecessary selling.
                </li>
              </ol>
              <p className="how-privacy">
                Your data never leaves your browser. <strong>Save file</strong> keeps your setup for
                next time.
              </p>
            </div>
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
            <SettingsButton scenario={scenario} onChange={setScenario} />
          </div>
        </header>

        {fileError && (
          <div className="card solve-error" role="alert">
            <h3>Couldn’t load that file</h3>
            <p>{fileError}</p>
          </div>
        )}

        <PortfolioEditor scenario={scenario} onChange={setScenario} />

        {scenario.portfolio.accounts.length > 0 && <StatusBar scenario={scenario} onChange={setScenario} />}

        {scenario.portfolio.accounts.length === 0 ? (
          // Until an account exists nothing can be computed: a quiet
          // placeholder marks where results will render, instead of the
          // solver's error. The real guidance lives next to each control.
          <p className="empty-note results-placeholder">
            Trades will appear here once you add an account — or load a previously saved
            file with <strong>Open file…</strong>
          </p>
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
        {/* Links open in a new tab: all state lives in this page, so
            navigating away would discard an unsaved portfolio. */}
        <p>
          rebalancetool is free and open source (MIT license), so the calculations are public and
          auditable:{" "}
          <a href="https://github.com/rebalancetool/rebalancetool" target="_blank" rel="noreferrer">
            view the source
          </a>{" "}
          or{" "}
          <a href="https://github.com/rebalancetool/rebalancetool/issues" target="_blank" rel="noreferrer">
            report an issue
          </a>{" "}
          on GitHub.
        </p>
      </footer>
    </div>
  );
}
