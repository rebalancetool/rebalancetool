import type { Scenario } from "@rebalancer/solver";

/**
 * What a first visit shows: a catalog of common total-market index funds
 * and the asset classes to file them under — and nothing else. No accounts,
 * no holdings, no target percentages, no dollar amounts. The catalog is an
 * editable convenience (rename, remove, or replace freely), not a
 * recommendation — the compliance footer says so explicitly — and every
 * number the solver ever sees is user-stated. Keep it that way: adding
 * default targets, holdings, or accounts here would recreate exactly the
 * "suggested portfolio" this file exists to avoid.
 */
export function starterScenario(): Scenario {
  return {
    portfolio: {
      assetClasses: [
        { id: "us_stocks", name: "US Stocks", taxPreference: "prefer_taxable" },
        { id: "intl_stocks", name: "International Stocks", taxPreference: "prefer_taxable" },
        { id: "us_bonds", name: "US Bonds", taxPreference: "prefer_tax_advantaged" },
        { id: "intl_bonds", name: "International Bonds", taxPreference: "prefer_tax_advantaged" },
      ],
      funds: [
        { id: "vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", assetClasses: { us_stocks: 10000 } },
        {
          id: "vxus",
          ticker: "VXUS",
          name: "Vanguard Total International Stock ETF",
          assetClasses: { intl_stocks: 10000 },
        },
        {
          id: "vt",
          ticker: "VT",
          name: "Vanguard Total World Stock ETF",
          assetClasses: { us_stocks: 6500, intl_stocks: 3500 },
        },
        { id: "bnd", ticker: "BND", name: "Vanguard Total Bond Market ETF", assetClasses: { us_bonds: 10000 } },
        {
          id: "bndx",
          ticker: "BNDX",
          name: "Vanguard Total International Bond ETF",
          assetClasses: { intl_bonds: 10000 },
        },
      ],
      accounts: [],
      holdings: [],
    },
    targets: [],
    contributions: [],
    options: { allowSelling: true, sellInTaxableAccounts: true },
  };
}
