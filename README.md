# rebalancer

An open-source portfolio rebalancing calculator. Given a multi-account
portfolio (taxable brokerage, IRAs, 401(k), HSA, ...) and a target asset
allocation, it computes the **buy-only** trades needed to move new
contributions toward that target — never sells, so it's safe to run any
time you add money.

This is the core engine and a CLI. There is no UI, no CSV import, and no
sell/rebalance-by-selling logic yet — see "Scope" below.

## How it works

**Inputs:**
- A **Portfolio**: `accounts` (each with a `taxType` and the list of funds it's allowed to hold), `funds` (each belonging to one `assetClass`), and current `holdings` (dollar value, in cents, of each fund in each account).
- **Targets**: the desired weight (in basis points, summing to 10000) for each asset class, across the *whole* portfolio combined.
- **Contributions**: new cash, each earmarked to a specific account — money never moves between accounts, since e.g. a 401(k) payroll contribution can't be redirected into an IRA. This is the one non-obvious modeling choice: `rebalance()` takes an array of `{ accountId, amount }`, not a single lump sum.

**Algorithm** (buy-only greedy waterfall — full detail in the comment block atop `packages/solver/src/rebalance.ts`):
1. Sum current holdings by asset class across all accounts, and compute each asset class's target dollar value at the post-contribution total.
2. Repeatedly find the asset class furthest below its target ("the biggest gap"), and buy into it using cash from the best eligible account — "eligible" meaning it still has uninvested contribution cash and offers a fund in that asset class. When more than one account is eligible, prefer the one whose tax type matches the asset class's `taxPreference` (e.g. bonds default to preferring tax-advantaged accounts), then break remaining ties by account id.
3. Repeat until every gap is closed or no eligible account remains for it (this is reported back as a warning, not silently dropped).
4. The solver **never sells** — if a contribution isn't big enough to close every gap, it closes the biggest ones and reports the remaining deviation. Every trade carries a human-readable `reason`.

**Output** (`RebalanceResult`): the list of `trades` to execute, the `resultingAllocation` and `deviationFromTarget` after applying them, and any `warnings` (e.g. "gap for X couldn't be closed — no account with remaining cash offers a fund for it").

Everything is pure and deterministic: same input always produces the same output, regardless of array ordering, with no I/O, no floats for money (integer cents throughout), and no network calls. That determinism/purity is what should make it safe to drop straight behind a web UI later — the solver has no notion of a request/response cycle to adapt.

## Project layout

```
packages/solver/    pure TypeScript rebalancing engine — no DOM, no fetch, no fs, no network calls
apps/cli/            thin CLI wrapper (tsx + node:util parseArgs) around @rebalancer/solver
```

`packages/solver`'s only public export is `rebalance()` plus the domain
types in `src/types.ts` (see "How it works" above).

## Prerequisites

- Node.js 24 (see `.nvmrc`). If you use [fnm](https://github.com/Schniz/fnm), just run
  `fnm use` in this directory and it'll pick up the right version automatically.
- [pnpm](https://pnpm.io/), via [Corepack](https://nodejs.org/api/corepack.html)
  (`corepack enable`, then `pnpm` just works — the exact version is pinned in
  `package.json`'s `packageManager` field).

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
pnpm solve -p <scenario.json> -c accountId:amountCents [-c accountId:amountCents ...]
```

`<scenario.json>` holds the portfolio (`assetClasses`, `funds`, `accounts`,
`holdings`) and `targets`, in the same shape as
`packages/solver/fixtures/example.json`. Each `-c`/`--contribution` flag
earmarks cash to one account — money never moves between accounts (you
can't put a 401(k) payroll contribution into an IRA), so there's no single
"total contribution" flag.

Try it against the placeholder example household:

```
pnpm solve -p packages/solver/fixtures/example.json -c taxable:40000 -c k401:15000 -c hsa:5000
```

## Scope

Built so far: domain types, the buy-only solver, its test suite (golden
fixture + invariant + property-based tests), and the CLI. Not built yet:
a UI, CSV/brokerage-export parsing, and sell logic (needed for a "full"
rebalance that can also trim overweight positions).

## CI

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run test` on every push.
