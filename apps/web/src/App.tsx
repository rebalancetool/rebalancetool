import { rebalance } from "@rebalancer/solver";
import type { RebalanceResult, Scenario } from "@rebalancer/solver";
import { useMemo, useRef, useState } from "react";
import { demoScenario } from "./demo-scenario.ts";
import { PortfolioEditor } from "./PortfolioEditor.tsx";
import { ResultView } from "./ResultView.tsx";
import { emptyScenario } from "./scenario-edit.ts";
import { scenarioFromJson, scenarioToJson } from "./scenario-file.ts";
import { ContributionsEditor, OptionsEditor, TargetsEditor } from "./ScenarioEditor.tsx";

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
    <main className="app">
      <header className="app-header">
        <div>
          <h1>Rebalancer</h1>
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
        </div>
      </header>

      {fileError && (
        <div className="card solve-error" role="alert">
          <h3>Couldn’t load that file</h3>
          <p>{fileError}</p>
        </div>
      )}

      <PortfolioEditor scenario={scenario} onChange={setScenario} />

      <section aria-labelledby="scenario-heading">
        <h2 id="scenario-heading">Plan</h2>
        <div className="editor-grid">
          <TargetsEditor scenario={scenario} onChange={setScenario} />
          <ContributionsEditor scenario={scenario} onChange={setScenario} />
          <OptionsEditor scenario={scenario} onChange={setScenario} />
        </div>
      </section>

      {outcome.result ? (
        <ResultView scenario={scenario} result={outcome.result} />
      ) : (
        <div className="card solve-error" role="alert">
          <h3>Can’t rebalance yet</h3>
          <p>{outcome.error}</p>
        </div>
      )}
    </main>
  );
}
