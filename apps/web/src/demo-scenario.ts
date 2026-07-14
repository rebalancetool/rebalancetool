import type { Scenario } from "@rebalancer/solver";

/**
 * Test fixture: the invented household the UI tests drive — a taxable
 * brokerage, two IRAs, a 401(k), and an HSA holding VT (a 65/35 blend, so
 * the blend editor is exercised), with selling enabled. Mirrors
 * packages/solver/fixtures/example.json. Deliberately NOT imported by the
 * app: the shipped UI starts with only the fund catalog in
 * starter-scenario.ts — never accounts, holdings, or targets — so it never
 * appears to suggest a portfolio (see the compliance footer).
 */
export const demoScenario: Scenario = {
  portfolio: {
    assetClasses: [
      { id: "us_stocks", name: "US Stocks", taxPreference: "prefer_taxable" },
      { id: "intl_stocks", name: "International Stocks", taxPreference: "prefer_taxable" },
      { id: "us_bonds", name: "US Bonds", taxPreference: "prefer_tax_advantaged" },
      { id: "intl_bonds", name: "International Bonds", taxPreference: "prefer_tax_advantaged" },
      { id: "us_small_cap_value", name: "US Small-Cap Value", taxPreference: "prefer_tax_advantaged" },
    ],
    funds: [
      { id: "vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", assetClasses: { us_stocks: 10000 } },
      { id: "vxus", ticker: "VXUS", name: "Vanguard Total International Stock ETF", assetClasses: { intl_stocks: 10000 } },
      { id: "bnd", ticker: "BND", name: "Vanguard Total Bond Market ETF", assetClasses: { us_bonds: 10000 } },
      { id: "bndx", ticker: "BNDX", name: "Vanguard Total International Bond ETF", assetClasses: { intl_bonds: 10000 } },
      { id: "avuv", ticker: "AVUV", name: "Avantis US Small Cap Value ETF", assetClasses: { us_small_cap_value: 10000 } },
      {
        id: "vt",
        ticker: "VT",
        name: "Vanguard Total World Stock ETF",
        assetClasses: { us_stocks: 6500, intl_stocks: 3500 },
      },
    ],
    accounts: [
      { id: "taxable", name: "Taxable Brokerage", taxType: "taxable", availableFundIds: ["vti", "vxus"] },
      { id: "roth_ira", name: "Roth IRA", taxType: "tax_free", availableFundIds: ["avuv", "vti", "bnd"] },
      { id: "spouse_ira", name: "Spouse Traditional IRA", taxType: "tax_deferred", availableFundIds: ["bnd", "bndx", "vti"] },
      { id: "k401", name: "401(k)", taxType: "tax_deferred", availableFundIds: ["bnd", "vti"] },
      { id: "hsa", name: "HSA", taxType: "tax_free", availableFundIds: ["vt", "avuv", "vxus"] },
    ],
    holdings: [
      { accountId: "taxable", fundId: "vti", value: 2000000 },
      { accountId: "taxable", fundId: "vxus", value: 800000 },
      { accountId: "roth_ira", fundId: "avuv", value: 300000 },
      { accountId: "roth_ira", fundId: "vti", value: 200000 },
      { accountId: "spouse_ira", fundId: "bnd", value: 500000 },
      { accountId: "k401", fundId: "vti", value: 1500000 },
      { accountId: "k401", fundId: "bnd", value: 500000 },
      { accountId: "hsa", fundId: "vt", value: 200000 },
    ],
  },
  targets: [
    { assetClassId: "us_stocks", weight: 4000 },
    { assetClassId: "intl_stocks", weight: 2000 },
    { assetClassId: "us_bonds", weight: 2000 },
    { assetClassId: "intl_bonds", weight: 1000 },
    { assetClassId: "us_small_cap_value", weight: 1000 },
  ],
  contributions: [
    { accountId: "taxable", amount: 40000 },
    { accountId: "k401", amount: 15000 },
    { accountId: "hsa", amount: 5000 },
  ],
  // Mirrors the UI's default posture: selling on, taxable accounts protected.
  options: { allowSelling: true, sellInTaxableAccounts: false },
};
