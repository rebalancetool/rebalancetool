import { expect, test } from "vitest";
import { describeOptions, formatBpsAsPercent, formatCents, formatDelta, formatSignedBpsAsPercent } from "./format.ts";

test("formatCents renders integer cents as dollars", () => {
  expect(formatCents(0)).toBe("$0.00");
  expect(formatCents(1)).toBe("$0.01");
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(-123456)).toBe("-$1,234.56");
  expect(formatCents(2000000)).toBe("$20,000.00");
});

test("formatDelta signs nonzero amounts and dashes zero", () => {
  expect(formatDelta(0)).toBe("—");
  expect(formatDelta(4000000)).toBe("+$40,000.00");
  expect(formatDelta(-4000000)).toBe("-$40,000.00");
});

test("formatBpsAsPercent", () => {
  expect(formatBpsAsPercent(10000)).toBe("100%");
  expect(formatBpsAsPercent(2550)).toBe("25.5%");
  expect(formatBpsAsPercent(1)).toBe("0.01%");
  expect(formatBpsAsPercent(0)).toBe("0%");
});

test("formatSignedBpsAsPercent", () => {
  expect(formatSignedBpsAsPercent(120)).toBe("+1.2%");
  expect(formatSignedBpsAsPercent(-55)).toBe("-0.6%");
  expect(formatSignedBpsAsPercent(0)).toBe("+0.0%");
});

test("describeOptions always states the selling posture and lists non-default knobs", () => {
  expect(describeOptions(undefined)).toBe("selling off");
  expect(describeOptions({ allowSelling: true })).toBe("selling on · taxable accounts protected");
  expect(
    describeOptions({ allowSelling: true, sellInTaxableAccounts: true, optimizeAssetLocation: true }),
  ).toBe("selling on · may sell in taxable accounts · optimizing asset location");
  expect(describeOptions({ toleranceBps: 0, minTradeCents: 500 })).toBe("selling off · tolerance ±0% · min trade $5.00");
});
