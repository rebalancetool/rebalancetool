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
LP to the true optimum on every small problem it can enumerate. The next
section argues why this reduction is necessary — why the obvious
arithmetic and greedy approaches are not merely weaker but *wrong*.

## Why a linear program?

Rebalancing looks like arithmetic: compute each asset class's dollar gap to
target, then walk the gaps — spend cash on underweight classes, and (when
selling is allowed) rotate overweight classes into underweight ones until
the gaps close. Early in this repo's history a greedy waterfall engine did
exactly that, behind the same allocator seam; it was removed (it's in git
history) once it was clear that the constraints below make any such pass
either incorrect or a slow re-derivation of a flow solver. This section is
the argument for why.

### The constraints couple everything to everything

Strip the problem to its variables: choose final integer-cent values
`x[account][fund]`, subject to

- **supply** — each account's post-trade total is *fixed* at its current
  value plus its own contribution: money never moves between accounts;
- **eligibility** — `x` may exceed the current position only if the account's
  menu allows buying that fund, and may fall below it only where selling is
  permitted (never in taxable accounts by default, never at all in buy-only
  mode);
- **demand** — each asset class's exposure, summed across every account and
  weighted through each fund's class mix, should land on its target dollars;

minimizing total deviation from target, then gross selling, and so on.

Two structural facts rule out per-class arithmetic and greedy passes:

1. **Feasibility is a property of *sets* of classes, not single classes.**
   Whether international can reach target depends on how much room is left
   in the accounts allowed to hold it *after* every other class competing
   for those same accounts takes its share. In flow terms these are
   Hall-type conditions: for every subset of asset classes, the combined
   (fixed) totals of the accounts able to hold them must cover their
   combined demand — exponentially many conditions, all coupled through
   shared accounts. A prorated split of each class's global gap across
   accounts satisfies these conditions only by luck; a flow/LP formulation
   satisfies all of them implicitly or reports the residual as a warning.

2. **Optimal gross trades are not determined by net class gaps.** Reaching
   target can require selling a class that is globally *underweight* in one
   account and buying it back in another — the gross flow in a class can
   exceed its net gap in both directions. Any rule of the form "over target
   ⇒ donor, under target ⇒ receiver" — however cleverly ordered — cannot
   even *express* that solution, let alone find it.

### A concrete example

This household is pinned as a test (`rebalance.test.ts`, "restricted fund
menus"). Two tax-deferred accounts, selling allowed, no new cash:

| Account | Fund menu | Holdings |
| --- | --- | --- |
| IRA — $80,000 | VTI, VXUS, BND | $30,000 VTI (US), $5,000 VXUS (intl), $45,000 BND (bonds) |
| 401(k) — $100,000 | S&P 500 fund, BND | $100,000 S&P 500 (US) |

Target is 50/20/30 US/intl/bonds on the $180,000 total: $90,000 / $36,000 /
$54,000. So US stocks are **$40,000 over**, international **$31,000
under**, bonds **$9,000 under** — and international is only buyable in the
IRA.

The greedy rule — sell the overweight class, buy the underweight ones —
plays out like this: the $31,000 international buy must happen in the IRA,
but the IRA's only overweight holding is $30,000 of VTI. Selling all of it
still leaves international $1,000 short, and the 401(k)'s side ($10,000 of
S&P sold, $9,000 of bonds bought) strands $1,000 of cash that must be
reinvested in US or bonds, pushing one of them over. Best case: $2,000 of
final deviation.

Yet an exact solution exists, and it's short:

- IRA: sell $30,000 VTI **and $1,000 BND**, buy $31,000 VXUS
- 401(k): sell $10,000 S&P 500, buy $10,000 BND

Every class lands exactly on target. The move a greedy rule can never make
is selling $1,000 of bonds — a class that is $9,000 *under* target — so the
401(k), whose menu can't host international, buys them back. And this isn't
one solution among many: since only the IRA can hold international, any
zero-deviation solution must put all $36,000 of it there, which forces the
IRA's other holdings down from $75,000 to $44,000 — a $31,000 sale of which
at most $30,000 can be VTI. *Every* exact solution sells underweight bonds.
Gross bond trades (+$10,000, −$1,000) exceed the $9,000 net gap, and the
$1,000 figure is not computable class-by-class — it's "international's gap
minus the IRA's sellable US", a coupling between one class's demand,
another's location constraint, and a third's role as the relocation
vehicle.

Each greedy patch you might bolt on ("allow selling underweight classes
when…", "look ahead when…") is one more step toward hand-implementing a
search over the set-feasibility conditions above. The end of that road is
an unproven, worse flow solver — which is why `allocate.ts` carries a "do
not hand-roll a min-cost-flow solver" comment.

### Why the transportation problem is the right model

The structure above *is* a fixed-supply transportation problem: accounts
are supply nodes (each with an immovable total), asset classes are demand
nodes (target dollars), and each (account × fund) position is a lane
between them, open only where the fund menu allows. "Money never leaves an
account" is exactly why supplies are fixed rather than pooled, and
minimizing unmet demand is the classic transportation objective. Modeling
it this way buys the two guarantees the greedy pass lacked: global
feasibility (every Hall-type condition handled implicitly) and provable
optimality of the result.

Two domain features then push the implementation past classical
transportation/min-cost-flow into a general **linear program**:

- **Blended funds.** VT (65% US / 35% intl) is a single lane that delivers
  to two demand nodes in fixed proportion — you can't ship its US component
  without shipping its international one. Flow networks have no such
  coupled edges; in an LP it's just a variable with two coefficients. This
  is what lets the solver sell VT and buy back only the international slice
  with VXUS to shed a US-only excess.
- **Lexicographic policy objectives.** Minimal deviation usually leaves many
  optimal solutions, and the solver must pick among them by policy: least
  gross selling, then least *taxable* selling, then tax-preferred
  placement, then the account's fund-preference order. In an LP each stage
  is one more solve with the previous optimum pinned as a constraint;
  grafting five prioritized objectives onto a bespoke flow algorithm is
  where such implementations go to die.

One objective is deliberately absent: minimizing the *number* of trades is
a fixed-charge problem (NP-hard — it would need integer programming). The
tolerance band is its practical stand-in: classes within the band are never
churned at all.

### What's layered on top of the LP

The LP is the core, but most of `packages/solver/src/allocate.lp.ts` is
machinery that makes a float-based simplex safe for exact, deterministic,
integer-cent money (the file's header comment is the full specification):

- **Exact eligibility before any float.** The tolerance band is applied to
  the *inputs*, in exact integer cent-basis-points: a class drifted beyond
  the band is penalized against its exact target; a class within the band
  is frozen against selling and never churned.
- **Five pinned stages.** Deviation → total sells → taxable sells →
  tax-preferred placement → fund-preference order, each solved with
  [YALPS](https://github.com/Ivordir/YALPS) (pure JS and synchronous, which
  keeps `rebalance()` pure and synchronous) and pinned as a constraint
  before the next stage runs, so later stages only break ties.
- **`minTradeCents` by iterative refinement.** "Zero or at least the floor"
  is not expressible in a single LP, so: solve, ban selling any position
  whose sell landed below the floor, re-solve, repeat — at most one solve
  per sellable position.
- **Integer repair.** Simplex floats are rounded back to cents by snapping
  (near-)untouched positions to exactly their current value — float noise
  never fabricates a one-cent trade — plus a per-account largest-remainder
  repair that conserves every account total exactly. Class totals may carry
  under a cent of noise per position, which the property tests account for
  as explicit slack.
- **Determinism.** The model is built in sorted-id order over a
  deterministic simplex, so shuffled input ordering produces the identical
  result (property-tested).
- **Verification.** `allocate.property.test.ts` enumerates every small
  problem it can (constrained single-account, unconstrained multi-account,
  constrained two-account) and holds the LP to a brute-force reference
  optimum.

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
