# rebalancer

An open-source portfolio rebalancing calculator. Given a multi-account
portfolio (taxable brokerage, IRAs, 401(k), HSA, ...) and a target asset
allocation, it computes the trades needed to move the portfolio toward that
target. Out of the box it is **buy-only** — it spends new contributions and
never sells, so it's safe to run any time you add money. With
`allowSelling` it also rotates overweight positions into underweight ones,
preferring tax-advantaged accounts and never touching taxable positions
unless you explicitly let it.

This is the core engine, a CLI, and a local-only web UI (see
[WEB_UI.md](WEB_UI.md)). There is no CSV import — see "Scope" below.

## Disclaimer

**This is a calculator, not investment advice.** The tools in this
repository perform arithmetic on information you provide: you choose the
asset classes, the target allocation, the funds, and which accounts may
hold them; the solver computes trades that move your stated holdings
toward your stated targets. It does not recommend any security,
allocation, or strategy; the web UI pre-loads only a generic, editable
fund list — no amounts, accounts, or allocation — and the fixture files
bundled for tests and CLI examples are illustrative only — not suggested
portfolios. Nothing here is investment, tax, or legal advice. Consult a
qualified professional before making investment decisions. The web UI
runs entirely in your browser; nothing you enter is transmitted or
stored by the site.

## How it works

**Input** is one JSON scenario document (the `Scenario` type — the same
shape a future UI would save/load):

- `portfolio`:
  - `accounts` — each with a `taxType` and `availableFundIds`, the funds it
    may buy, **ordered most-preferred first** (the first entry is also where
    leftover contribution cash lands).
  - `funds` — each with an `assetClasses` map of asset-class weights in
    basis points summing to 10000. Most funds map one class to 10000; a
    blended fund like VT is `{ "us_stocks": 6500, "intl_stocks": 3500 }`,
    and its buys/sells move both components in lockstep.
  - `holdings` — current dollar value (integer cents) of each fund in each account.
- `targets` — desired weight (integer basis points, summing to 10000) per
  asset class, across the *whole* portfolio combined.
- `contributions` — new cash, each earmarked to a specific account. Money
  never moves between accounts (a 401(k) payroll contribution can't be
  redirected into an IRA), so this is an array of `{ accountId, amount }`,
  not a single lump sum. That constraint also means cash raised by a *sell*
  can only buy funds in that same account.
- `options` (all optional):
  - `allowSelling` (default `false`) — enable the sell pass.
  - `sellInTaxableAccounts` (default `false`) — allow sells that could
    realize capital gains; without it, taxable positions are never trimmed.
  - `toleranceBps` (default `50`) — the tolerance band: an asset class
    within ±0.5% of its target weight is treated as on-target, so trivial
    drift never triggers trades. `0` = rebalance exactly.
  - `minTradeCents` (default `0`) — floor on individual sell-funded moves:
    a sell either clears the floor or doesn't happen. (Contribution cash is
    always fully invested, however small — cash may not sit idle in an
    account.)

**Algorithm.** The placement is solved as a linear program
([YALPS](https://github.com/Ivordir/YALPS)) over per-(account × fund)
positions, with a lexicographic objective — provably minimal deviation, then
minimal selling, then minimal *taxable* selling, then tax-preferred
placement, then fund-preference order (full detail in the comment atop
`packages/solver/src/allocate.lp.ts`):

1. Current holdings are summed by asset class across all accounts (a blended
   fund's value counts toward each component class in proportion to its
   weights), and each class's target dollar value is computed at the
   post-contribution total. Gaps or excesses within the tolerance band are
   treated as zero.
2. The LP then finds the final position values that minimize the remaining
   deviation, subject to the hard constraints: money never leaves an
   account, non-buyable positions can't grow, no class is ever sold below
   its own target, and — without `allowSelling` / `sellInTaxableAccounts` —
   the corresponding positions can't shrink at all. Because it optimizes
   globally, it can *relocate* a class between accounts when restricted fund
   menus require it (e.g. sell bonds in the IRA to finish funding
   international there, while the 401(k) buys the bonds back), and blended
   funds are native: it can even sell VT and buy back the international
   slice with VXUS to shed only the US excess.
3. Contribution cash is always fully invested — cash may not sit idle in
   an account. Surplus beyond every reachable gap is placed by the asset
   classes' `taxPreference` first (e.g. surplus in an IRA parks in a
   `prefer_tax_advantaged` class when the account offers one), then by the
   account's fund preference order within the chosen class.
4. Any gap that survives is reported as a warning, not silently dropped.
   Every trade carries a human-readable `reason`.

**Output** (`RebalanceResult`): the list of `trades` (buys *and* sells), a
per-account before/after breakdown (`accounts`: contribution, totals, and
every position's current/traded/final value), the `resultingAllocation`
(with current and target dollars per asset class) and `deviationFromTarget`
after applying the trades, and any `warnings`.

Everything is pure and deterministic: same input always produces the same
output, regardless of array ordering, with no I/O, no floats for money
(integer cents throughout), and no network calls. That determinism/purity is
what should make it safe to drop straight behind a web UI later — the solver
has no notion of a request/response cycle to adapt.

Internally, `rebalance()` reduces its input to a fixed-supply transportation
problem in (account × fund) space — asset-class demands connected to fund
positions through each fund's class weights (the seam defined in
`packages/solver/src/allocate.ts`) — and delegates placement to the LP in
`allocate.lp.ts`. A brute-force reference in the property tests holds the
LP to the true optimum on every small problem it can enumerate.

## Project layout

```
packages/solver/    pure TypeScript rebalancing engine — no DOM, no fetch, no fs, no network calls
apps/cli/            thin CLI wrapper (tsx + node:util parseArgs) around @rebalancer/solver
apps/web/            React (Vite) UI over the solver — no backend, state lives in the page (WEB_UI.md)
```

`packages/solver`'s public exports are `rebalance()`, `validateScenario()`
(structural validation of an untrusted scenario JSON document),
`DEFAULT_TOLERANCE_BPS`, and the domain types in `src/types.ts`.

## Prerequisites

- **Node.js 24** (see `.nvmrc`). If you use [fnm](https://github.com/Schniz/fnm), just run
  `fnm use` in this directory and it'll pick up the right version automatically.
- **pnpm 11**, via [Corepack](https://nodejs.org/api/corepack.html) (bundled with Node — run
  `corepack enable` once, and `pnpm` just works, resolved to the exact version pinned in
  `package.json`'s `packageManager` field, currently `pnpm@11.11.0`).
  - Corepack shims are written per Node install. If you later switch to a different Node
    version (via fnm or otherwise), run `corepack enable` again under it — otherwise `pnpm`
    won't be on `PATH` for that version.
- Everything else (TypeScript, vitest, fast-check, tsx) is a `devDependency` pulled in by
  `pnpm install` below — nothing else to install by hand. Note this repo currently pins
  **TypeScript 7.x**, not the more common 5.x — that's intentional, not a typo.

## Setup

```
pnpm install
```

## Commands

```
pnpm dev             # start the web UI dev server (http://localhost:5173)
pnpm run typecheck   # type-check every package, no emit
pnpm run test        # run all tests once (vitest + fast-check property tests)
pnpm run test:watch  # run the solver's tests in watch mode
pnpm run build       # compile every package to dist/
```

## CLI

```
pnpm solve -p <scenario.json> [overrides]
```

The scenario file is the complete input (portfolio + targets + contributions
+ options) in the shape of `packages/solver/fixtures/example.json`. Flags
override the file:

```
-c, --contribution <accountId:amountCents>  replace the file's contributions (repeatable)
    --sell                                  allow selling (options.allowSelling)
    --sell-taxable                          also allow sells in taxable accounts (implies --sell)
    --tolerance-bps <n>                     tolerance band in basis points
    --min-trade-cents <n>                   minimum sell-funded trade size
```

Try it against the placeholder fixtures:

```
# buy-only: invest the fixture's contributions
pnpm solve -p packages/solver/fixtures/example.json

# override the contributions from the command line
pnpm solve -p packages/solver/fixtures/example.json -c taxable:40000 -c k401:15000 -c hsa:5000

# a drifted portfolio that can only reach target by selling
pnpm solve -p packages/solver/fixtures/sell-required.json
```

The output lists trades grouped by account (sells before buys, each with its
reason), a per-asset-class table of current → target → trades → final value
with the remaining dollar/percent deviation, a per-account breakdown showing
every position's current, traded, and final value (so you can verify the
starting numbers against your real accounts and the final ones after
executing the trades), and any warnings. Warnings are reserved for
actionable problems — e.g. a targeted asset class that no funded account
offers — not for ordinary "contribution wasn't enough" shortfalls, which the
tables already show.

## Scope

Built so far: domain types, the LP solver (buy-only by default,
opt-in selling with tax-aware guards and tolerance bands), the canonical
JSON scenario format with `validateScenario()`, the test suite (golden
fixtures + invariant + property-based tests, including a brute-force
optimality check on the allocator), the CLI, and a local-only web UI
([WEB_UI.md](WEB_UI.md)) that builds/edits scenarios, solves live, and
saves/loads the canonical JSON, with a per-fund blend editor for
multi-class funds. Not built yet: CSV/brokerage-export parsing,
prices/shares/cost-basis (a holding is just fund → dollars), and
capital-gains-aware sell selection.

## CI

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run test` on every push.
