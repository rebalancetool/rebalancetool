import { expect, test } from "vitest";
import { bpsToText, centsToText, parseDollarsToCents, parsePercentToBps } from "./parse.ts";

test("parseDollarsToCents parses plain, formatted, and fractional amounts exactly", () => {
  expect(parseDollarsToCents("0")).toBe(0);
  expect(parseDollarsToCents("")).toBe(0);
  expect(parseDollarsToCents("400")).toBe(40000);
  expect(parseDollarsToCents("1,234.56")).toBe(123456);
  expect(parseDollarsToCents("$1,234.56")).toBe(123456);
  expect(parseDollarsToCents("0.1")).toBe(10);
  expect(parseDollarsToCents("123.4")).toBe(12340);
  // Exactness: no float rounding surprises.
  expect(parseDollarsToCents("123.45")).toBe(12345);
  expect(parseDollarsToCents("0.29")).toBe(29);
});

test("parseDollarsToCents rejects garbage", () => {
  expect(parseDollarsToCents("abc")).toBeNull();
  expect(parseDollarsToCents("1.234")).toBeNull(); // sub-cent precision
  expect(parseDollarsToCents("-5")).toBeNull(); // negative money is never typed
  expect(parseDollarsToCents("1 000")).toBeNull();
});

test("parsePercentToBps parses percent text into basis points", () => {
  expect(parsePercentToBps("")).toBe(0);
  expect(parsePercentToBps("40")).toBe(4000);
  expect(parsePercentToBps("12.5")).toBe(1250);
  expect(parsePercentToBps("0.25")).toBe(25);
  expect(parsePercentToBps("100")).toBe(10000);
  expect(parsePercentToBps("40%")).toBe(4000);
});

test("parsePercentToBps rejects garbage", () => {
  expect(parsePercentToBps("forty")).toBeNull();
  expect(parsePercentToBps("12.345")).toBeNull(); // finer than 1 bp
  expect(parsePercentToBps("-10")).toBeNull();
});

test("centsToText and bpsToText round-trip through their parsers", () => {
  for (const cents of [0, 1, 10, 100, 12345, 4000000]) {
    expect(parseDollarsToCents(centsToText(cents))).toBe(cents);
  }
  for (const bps of [0, 1, 25, 50, 1250, 4000, 10000]) {
    expect(parsePercentToBps(bpsToText(bps))).toBe(bps);
  }
  expect(centsToText(12345)).toBe("123.45");
  expect(bpsToText(1250)).toBe("12.5");
  expect(bpsToText(25)).toBe("0.25");
});
