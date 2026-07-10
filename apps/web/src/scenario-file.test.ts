import { expect, test } from "vitest";
import { demoScenario } from "./demo-scenario.ts";
import { scenarioFromJson, scenarioToJson } from "./scenario-file.ts";

test("a downloaded scenario round-trips through upload unchanged", () => {
  expect(scenarioFromJson(scenarioToJson(demoScenario))).toEqual(demoScenario);
});

test("the version stamp is a comment key the validator ignores", () => {
  expect(scenarioToJson(demoScenario)).toContain('"_format": "rebalancer-scenario-v1"');
});

test("non-JSON is rejected with a readable message", () => {
  expect(() => scenarioFromJson("not json {")).toThrow("That file isn't valid JSON.");
});

test("structurally invalid scenarios are rejected by the solver's validator", () => {
  expect(() => scenarioFromJson('{"portfolio": {}}')).toThrow();
  expect(() => scenarioFromJson('{"nonsense": true}')).toThrow();
});
