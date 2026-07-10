# rebalancer

An open-source portfolio rebalancing calculator. Given a multi-account
portfolio (taxable brokerage, IRAs, 401(k), HSA, ...) and a target asset
allocation, it computes the trades needed to move the portfolio toward that
target. Out of the box it is **buy-only** — it spends new contributions and
never sells, so it's safe to run any time you add money. With
`allowSelling` it also rotates overweight positions into underweight ones,
preferring tax-advantaged accounts and never touching taxable positions
unless you explicitly let it.

This is the core engine and a CLI. There is no UI and no CSV import — see
"Scope" below.

## How it works

**Input** is one JSON scenario document (the `Scenario` type — the same
shape a future UI would save/load):

- `portfolio`:
  - `accounts` — each with a `taxType` and `availableFundIds`, the funds it
    may buy, **ordered most-preferred first** (the first entry is also where
    leftover contribution cash lands).
  - `funds` — each belonging to one `assetClass`.
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
  - `minTradeCents` (default `0`) — floor on individual sell-funded moves.
    (Contribution cash is always fully invested, however small — cash may
    not sit idle in an account.)

**Algorithm** (greedy waterfall in two passes — full detail in the comment
block atop `packages/solver/src/rebalance.ts`):

1. Sum current holdings by asset class across all accounts, and compute each
   asset class's target dollar value at the post-contribution total. Gaps or
   excesses within the tolerance band are treated as zero.
2. **Buy pass** — repeatedly find the asset class furthest below target and
   buy into it using contribution cash from the best eligible account,
   ranked by the asset class's `taxPreference` (e.g. bonds prefer
   tax-advantaged accounts), then by account id. Leftover cash that can't
   reach any gap is invested in the account's most-preferred fund.
3. **Sell pass** (only with `allowSelling`) — for each class still
   underweight, find an account that can buy it *and* holds an overweight
   class; sell the overweight position (least-preferred fund first) and
   redeploy the proceeds in the same account. Every sell draws down a global
   excess budget, so no class is ever sold below its own target; sells
   prefer tax-advantaged accounts, and skip taxable ones entirely unless
   `sellInTaxableAccounts` is set.
4. Any gap that survives both passes is reported as a warning, not silently
   dropped. Every trade carries a human-readable `reason`.

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
problem and delegates placement to `allocate()`
(`packages/solver/src/allocate.ts`) — a deliberate seam so the greedy
implementation can later be swapped for an LP-backed one without touching
callers, the scenario format, or the tests.

## Project layout

```
packages/solver/    pure TypeScript rebalancing engine — no DOM, no fetch, no fs, no network calls
apps/cli/            thin CLI wrapper (tsx + node:util parseArgs) around @rebalancer/solver
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

Built so far: domain types, the two-pass solver (buy-only by default,
opt-in selling with tax-aware guards and tolerance bands), the canonical
JSON scenario format with `validateScenario()`, the test suite (golden
fixtures + invariant + property-based tests, including a brute-force
optimality check on the allocator), and the CLI. Not built yet: a UI,
CSV/brokerage-export parsing, prices/shares/cost-basis (a holding is just
fund → dollars), and capital-gains-aware sell selection.

## CI

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run test` on every push.
