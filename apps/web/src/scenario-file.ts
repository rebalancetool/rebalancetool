import { validateScenario } from "@rebalancer/solver";
import type { Scenario } from "@rebalancer/solver";

/**
 * The download/upload format is exactly the solver's canonical Scenario
 * JSON — the same document the CLI reads (packages/solver/fixtures/*.json),
 * so files move freely between the web UI and `pnpm solve -p`. Keys starting
 * with "_" are comments the validator ignores; we stamp a version comment on
 * download so future format changes can tell old files apart.
 */

export const SCENARIO_FILE_VERSION = "rebalancer-scenario-v1";

export function scenarioToJson(scenario: Scenario): string {
  return `${JSON.stringify({ _format: SCENARIO_FILE_VERSION, ...scenario }, null, 2)}\n`;
}

/** Parse + structurally validate an untrusted file. Throws with a readable message. */
export function scenarioFromJson(text: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return validateScenario(parsed);
}
