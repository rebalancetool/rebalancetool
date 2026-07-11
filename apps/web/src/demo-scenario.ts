import type { Scenario } from "@rebalancer/solver";

/**
 * The starting scenario shown on first load — a copy of the solver's
 * placeholder fixture (packages/solver/fixtures/example.json): an invented
 * household with a taxable brokerage, two IRAs, a 401(k), and an HSA. Not
 * real account data. Kept as a typed const because the fixture file is not
 * part of the solver's public exports. One deliberate difference from the
 * fixture: the web UI turns selling on by default, taxable accounts
 * included (the checkbox at the top of the page turns taxable sells off).
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
      { id: "vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", assetClassId: "us_stocks" },
      { id: "vxus", ticker: "VXUS", name: "Vanguard Total International Stock ETF", assetClassId: "intl_stocks" },
      { id: "bnd", ticker: "BND", name: "Vanguard Total Bond Market ETF", assetClassId: "us_bonds" },
      { id: "bndx", ticker: "BNDX", name: "Vanguard Total International Bond ETF", assetClassId: "intl_bonds" },
      { id: "avuv", ticker: "AVUV", name: "Avantis US Small Cap Value ETF", assetClassId: "us_small_cap_value" },
    ],
    accounts: [
      { id: "taxable", name: "Taxable Brokerage", taxType: "taxable", availableFundIds: ["vti", "vxus"] },
      { id: "roth_ira", name: "Roth IRA", taxType: "tax_free", availableFundIds: ["avuv", "vti", "bnd"] },
      { id: "spouse_ira", name: "Spouse Traditional IRA", taxType: "tax_deferred", availableFundIds: ["bnd", "bndx", "vti"] },
      { id: "k401", name: "401(k)", taxType: "tax_deferred", availableFundIds: ["bnd", "vti"] },
      { id: "hsa", name: "HSA", taxType: "tax_free", availableFundIds: ["vti", "avuv", "vxus"] },
    ],
    holdings: [
      { accountId: "taxable", fundId: "vti", value: 2000000 },
      { accountId: "taxable", fundId: "vxus", value: 800000 },
      { accountId: "roth_ira", fundId: "avuv", value: 300000 },
      { accountId: "roth_ira", fundId: "vti", value: 200000 },
      { accountId: "spouse_ira", fundId: "bnd", value: 500000 },
      { accountId: "k401", fundId: "vti", value: 1500000 },
      { accountId: "k401", fundId: "bnd", value: 500000 },
      { accountId: "hsa", fundId: "vti", value: 200000 },
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
  options: { allowSelling: true, sellInTaxableAccounts: true },
};
