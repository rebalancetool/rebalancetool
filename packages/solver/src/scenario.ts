import type {
  Account,
  AssetClass,
  Contribution,
  Fund,
  Holding,
  RebalanceOptions,
  Scenario,
  Target,
  TaxPreference,
  TaxType,
} from "./types.ts";

/**
 * Validates that an untrusted, already-parsed JSON document (e.g. from a
 * scenario file or a UI save) has the structural shape of a Scenario, and
 * returns a typed copy. Purely structural: field presence, primitive types,
 * and enum membership. Semantic rules (targets summing to 10000, referential
 * integrity of ids, non-negative integer cents) are enforced by rebalance()
 * itself — the solver stays the trust boundary.
 *
 * Top-level and portfolio-level keys starting with "_" are ignored (used
 * for comments in fixture files); any other unknown key is an error, so
 * typos fail loudly instead of being silently dropped.
 */
export function validateScenario(input: unknown): Scenario {
  const doc = requireRecord(input, "scenario");

  if (!("portfolio" in doc) && "assetClasses" in doc) {
    throw new Error(
      'Scenario has no "portfolio" key but does have a top-level "assetClasses" — this looks like the old flat ' +
        'format. Nest assetClasses/funds/accounts/holdings under a "portfolio" key.',
    );
  }
  checkKnownKeys(doc, ["portfolio", "targets", "contributions", "options"], "scenario");

  const portfolio = requireRecord(doc.portfolio, "portfolio");
  checkKnownKeys(portfolio, ["assetClasses", "funds", "accounts", "holdings"], "portfolio");

  return {
    portfolio: {
      assetClasses: requireArray(portfolio.assetClasses, "portfolio.assetClasses").map(parseAssetClass),
      funds: requireArray(portfolio.funds, "portfolio.funds").map(parseFund),
      accounts: requireArray(portfolio.accounts, "portfolio.accounts").map(parseAccount),
      holdings: requireArray(portfolio.holdings, "portfolio.holdings").map(parseHolding),
    },
    targets: requireArray(doc.targets, "targets").map(parseTarget),
    contributions:
      doc.contributions === undefined ? [] : requireArray(doc.contributions, "contributions").map(parseContribution),
    options: doc.options === undefined ? undefined : parseOptions(doc.options),
  };
}

const TAX_TYPES: readonly TaxType[] = ["taxable", "tax_deferred", "tax_free"];
const TAX_PREFERENCES: readonly TaxPreference[] = ["prefer_taxable", "prefer_tax_advantaged", "neutral"];

function parseAssetClass(value: unknown, index: number): AssetClass {
  const path = `portfolio.assetClasses[${index}]`;
  const record = requireRecord(value, path);
  const assetClass: AssetClass = {
    id: requireString(record.id, `${path}.id`),
    name: requireString(record.name, `${path}.name`),
  };
  if (record.taxPreference !== undefined) {
    assetClass.taxPreference = requireOneOf(record.taxPreference, TAX_PREFERENCES, `${path}.taxPreference`);
  }
  return assetClass;
}

function parseFund(value: unknown, index: number): Fund {
  const path = `portfolio.funds[${index}]`;
  const record = requireRecord(value, path);
  const fund: Fund = {
    id: requireString(record.id, `${path}.id`),
    name: requireString(record.name, `${path}.name`),
    assetClassId: requireString(record.assetClassId, `${path}.assetClassId`),
  };
  if (record.ticker !== undefined) fund.ticker = requireString(record.ticker, `${path}.ticker`);
  return fund;
}

function parseAccount(value: unknown, index: number): Account {
  const path = `portfolio.accounts[${index}]`;
  const record = requireRecord(value, path);
  return {
    id: requireString(record.id, `${path}.id`),
    name: requireString(record.name, `${path}.name`),
    taxType: requireOneOf(record.taxType, TAX_TYPES, `${path}.taxType`),
    availableFundIds: requireArray(record.availableFundIds, `${path}.availableFundIds`).map((fundId, i) =>
      requireString(fundId, `${path}.availableFundIds[${i}]`),
    ),
  };
}

function parseHolding(value: unknown, index: number): Holding {
  const path = `portfolio.holdings[${index}]`;
  const record = requireRecord(value, path);
  return {
    accountId: requireString(record.accountId, `${path}.accountId`),
    fundId: requireString(record.fundId, `${path}.fundId`),
    value: requireNumber(record.value, `${path}.value`),
  };
}

function parseTarget(value: unknown, index: number): Target {
  const path = `targets[${index}]`;
  const record = requireRecord(value, path);
  return {
    assetClassId: requireString(record.assetClassId, `${path}.assetClassId`),
    weight: requireNumber(record.weight, `${path}.weight`),
  };
}

function parseContribution(value: unknown, index: number): Contribution {
  const path = `contributions[${index}]`;
  const record = requireRecord(value, path);
  return {
    accountId: requireString(record.accountId, `${path}.accountId`),
    amount: requireNumber(record.amount, `${path}.amount`),
  };
}

function parseOptions(value: unknown): Omit<RebalanceOptions, "contributions"> {
  const record = requireRecord(value, "options");
  checkKnownKeys(record, ["allowSelling", "sellInTaxableAccounts", "toleranceBps", "minTradeCents"], "options");
  const options: Omit<RebalanceOptions, "contributions"> = {};
  if (record.allowSelling !== undefined) {
    options.allowSelling = requireBoolean(record.allowSelling, "options.allowSelling");
  }
  if (record.sellInTaxableAccounts !== undefined) {
    options.sellInTaxableAccounts = requireBoolean(record.sellInTaxableAccounts, "options.sellInTaxableAccounts");
  }
  if (record.toleranceBps !== undefined) {
    options.toleranceBps = requireNumber(record.toleranceBps, "options.toleranceBps");
  }
  if (record.minTradeCents !== undefined) {
    options.minTradeCents = requireNumber(record.minTradeCents, "options.minTradeCents");
  }
  return options;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${path} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array.`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${path} to be a string.`);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number") throw new Error(`Expected ${path} to be a number.`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Expected ${path} to be a boolean.`);
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`Expected ${path} to be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}.`);
  }
  return value as T;
}

function checkKnownKeys(record: Record<string, unknown>, known: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (key.startsWith("_") || known.includes(key)) continue;
    throw new Error(`Unknown key "${key}" in ${path}.`);
  }
}
