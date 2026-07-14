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

**This is a calculator, not investment advice.** The tools here perform
arithmetic on information you provide: you choose the asset classes, the
targets, the funds, and which accounts may hold them; the solver computes
trades that move your stated holdings toward your stated targets. It does
not recommend any security, allocation, or strategy — the web UI pre-loads
only a generic, editable fund list (no amounts, accounts, or allocation),
and the bundled fixture files are illustrative, not suggested portfolios.
Nothing here is investment, tax, or legal advice; consult a qualified
professional before making investment decisions. The web UI runs entirely
in your browser — nothing you enter is transmitted or stored by the site.

## How it works

**Input** is one JSON scenario document (the `Scenario` type — the same
document the CLI and web UI read and write):

- `portfolio`:
  - `accounts` — each with a `taxType` and `availableFundIds`, the funds it
    may buy, **ordered most-preferred first**.
  - `funds` — each with an `assetClasses` map of weights in basis points
    summing to 10000. Most funds map one class to 10000; a blend like VT is
    `{ "us_stocks": 6500, "intl_stocks": 3500 }`, and trading it moves both
    components in lockstep.
  - `holdings` — current value (integer cents) of each fund in each account.
- `targets` — desired weight per asset class (integer basis points, summing
  to 10000) across the *whole* portfolio combined.
- `contributions` — new cash, each earmarked to a specific account: an array
  of `{ accountId, amount }`, not a lump sum. Money never moves between
  accounts (a 401(k) payroll contribution can't be redirected into an IRA),
  and cash raised by a *sell* can only buy funds in that same account.
- `options` (all optional):
  - `allowSelling` (default `false`) — enable the sell pass.
  - `sellInTaxableAccounts` (default `false`) — allow sells that could
    realize capital gains; without it, taxable positions are never trimmed.
  - `toleranceBps` (default `50`) — an asset class within ±0.5% of its
    target weight is treated as on-target, so trivial drift never triggers
    trades. `0` = rebalance exactly.
  - `minTradeCents` (default `0`) — floor on individual sell-funded moves:
    a sell either clears the floor or doesn't happen.

**Algorithm.** Placement is solved as a linear program
([YALPS](https://github.com/Ivordir/YALPS)) over per-(account × fund)
positions, with a lexicographic objective — provably minimal deviation, then
minimal selling, then minimal *taxable* selling, then tax-preferred
placement, then fund-preference order (full detail in the comment atop
`packages/solver/src/allocate.lp.ts`):

1. Holdings are summed by asset class (a blend counts toward each component
   class in proportion to its weights), and each class's target dollars are
   computed at the post-contribution total. Gaps within the tolerance band
   count as zero.
2. The LP finds the final positions that minimize the remaining deviation,
   subject to the hard constraints: money never leaves an account,
   non-buyable positions can't grow, no class is ever sold below its own
   target, and — without `allowSelling` / `sellInTaxableAccounts` — the
   corresponding positions can't shrink at all. Because it optimizes
   globally, it can *relocate* a class between accounts when restricted
   fund menus require it, and blended funds are handled natively.
3. Contribution cash is always fully invested — cash may not sit idle in an
   account, however small the amount. Surplus beyond every reachable gap is
   placed by the asset classes' `taxPreference` first, then by the
   account's fund-preference order.
4. Any gap that survives is reported as a warning, not silently dropped,
   and every trade carries a human-readable `reason`.

**Output** (`RebalanceResult`): the `trades` (buys *and* sells), a
per-account before/after breakdown of every position, the
`resultingAllocation` and `deviationFromTarget` after applying the trades,
and any `warnings`.

Everything is pure and deterministic: same input, same output, regardless
of array ordering — no I/O, no network calls, no floats for money (integer
cents throughout). That is what makes the solver safe to drop straight
behind a UI.

Internally, `rebalance()` reduces its input to a fixed-supply
transportation problem (the seam in `packages/solver/src/allocate.ts`) and
delegates placement to the LP. The next section explains why that model —
and not simpler arithmetic — is required.

## Why a linear program?

Rebalancing looks like arithmetic: compute each asset class's dollar gap to
target, then walk the gaps — spend cash on underweight classes and, when
selling is allowed, rotate overweight into underweight until the gaps
close. This repo's first engine was exactly that greedy waterfall (it's in
git history). It was removed because the constraints below make any such
pass either incorrect or a slow re-derivation of a flow solver.

### The constraints couple everything to everything

Strip the problem to its variables: choose final integer-cent values
`x[account][fund]`, subject to

- **supply** — each account's post-trade total is *fixed* at its current
  value plus its own contribution: money never moves between accounts;
- **eligibility** — a position may grow only if the account's menu allows
  buying that fund, and shrink only where selling is permitted;
- **demand** — each asset class's exposure, summed across accounts through
  each fund's class weights, should land on its target dollars;

minimizing deviation from target, then gross selling, and so on. Two
structural facts rule out per-class arithmetic and greedy passes:

1. **Feasibility is a property of *sets* of classes, not single classes.**
   Whether international can reach target depends on how much room the
   accounts allowed to hold it have left *after* every other class
   competing for those accounts takes its share. In flow terms these are
   Hall-type conditions — one per subset of classes, all coupled through
   shared accounts. Prorating each class's gap across accounts satisfies
   them only by luck; a flow formulation satisfies all of them implicitly.

2. **Optimal gross trades are not determined by net class gaps.** Reaching
   target can require selling a globally *underweight* class in one account
   and buying it back in another. A rule of the form "over target ⇒ sell,
   under target ⇒ buy" — however cleverly ordered — cannot even *express*
   that solution, let alone find it.

### A concrete example

Two tax-deferred accounts, selling allowed, no new cash (pinned as a test
in `rebalance.test.ts`, "restricted fund menus"):

| Account | Fund menu | Holdings |
| --- | --- | --- |
| IRA — $80,000 | VTI, VXUS, BND | $30,000 VTI (US), $5,000 VXUS (intl), $45,000 BND (bonds) |
| 401(k) — $100,000 | S&P 500 fund, BND | $100,000 S&P 500 (US) |

Target is 50/20/30 US/intl/bonds of the $180,000 total: $90,000 / $36,000 /
$54,000. So US stocks are **$40,000 over**, international **$31,000 under**,
bonds **$9,000 under** — and international is only buyable in the IRA.

Greedy ("sell overweight, buy underweight") gets stuck: the $31,000
international buy must happen in the IRA, but the IRA's only overweight
holding is $30,000 of VTI. Selling all of it leaves international $1,000
short — and the 401(k)'s side ($10,000 of S&P sold, $9,000 of bonds bought)
strands $1,000 of cash that must be reinvested into US or bonds, pushing
one of them over. Best case: $2,000 of final deviation.

Yet an exact solution exists:

- IRA: sell $30,000 VTI **and $1,000 BND**, buy $31,000 VXUS
- 401(k): sell $10,000 S&P 500, buy $10,000 BND

The move greedy can never make is selling $1,000 of bonds — a class $9,000
*under* target — so that the 401(k), which can't hold international, buys
them back. And it isn't one solution among many: only the IRA can hold
international, so any exact solution puts all $36,000 of it there, forcing
$31,000 of other IRA sales — of which at most $30,000 can be VTI. *Every*
exact solution sells underweight bonds. The $1,000 is "international's gap
minus the IRA's sellable US": a coupling across three classes and two
accounts that no class-by-class formula sees.

Every greedy patch you might bolt on ("allow selling underweight classes
when…", "look ahead when…") is a step toward hand-implementing that coupled
search. The end of that road is an unproven, worse flow solver — hence the
"do not hand-roll a min-cost-flow solver" comment in `allocate.ts`.

### Why the transportation problem is the right model

The structure above *is* a fixed-supply transportation problem: accounts
are supply nodes (immovable totals — "money never leaves an account" is why
supplies are fixed rather than pooled), asset classes are demand nodes
(target dollars), and each menu-permitted (account × fund) position is a
lane between them. Modeling it this way buys the two guarantees greedy
lacked: global feasibility and provable optimality.

Two domain features then push the implementation past a classical
min-cost-flow algorithm to a general **linear program**:

- **Blended funds.** VT (65% US / 35% intl) is a single lane delivering to
  two demand nodes in fixed proportion — you can't ship its US component
  without shipping its international one. Flow networks have no such edges;
  in an LP it's just a variable with two coefficients. This is what lets
  the solver sell VT and buy back only the international slice with VXUS to
  shed a US-only excess.
- **Lexicographic policy objectives.** Minimal deviation usually leaves
  many optimal solutions to choose among by policy: least selling, then
  least *taxable* selling, then tax-preferred placement, then fund order.
  In an LP each stage is one more solve with the previous optimum pinned as
  a constraint; grafting five prioritized objectives onto a bespoke flow
  algorithm is where such implementations go to die.

One objective is deliberately absent: minimizing the *number* of trades is
a fixed-charge problem (NP-hard — it would need integer programming). The
tolerance band is its practical stand-in: classes within the band are never
touched at all.

### What's layered on top of the LP

The LP is the core; most of `packages/solver/src/allocate.lp.ts` is
machinery that makes a float-based simplex safe for exact integer-cent
money (its header comment is the full specification):

- **Exact eligibility first.** The tolerance band is applied to the
  *inputs* in exact integer arithmetic: a class beyond the band is pulled
  to its exact target; a class within it is frozen against selling and
  never churned.
- **Five pinned stages** (deviation → sells → taxable sells → tax
  preference → fund order), each solved with YALPS — pure JS and
  synchronous, keeping `rebalance()` pure — and pinned as a constraint
  before the next stage runs, so later stages only break ties.
- **`minTradeCents` by iterative refinement.** "Zero or at least the floor"
  isn't expressible in a single LP: solve, ban selling any position whose
  sell landed below the floor, re-solve, repeat.
- **Integer repair.** Near-untouched positions snap back to exactly their
  current value (float noise never fabricates a one-cent trade); a
  per-account largest-remainder pass conserves every account total to the
  cent. Class totals may carry under a cent of noise per position, which
  the property tests carry as explicit slack.
- **Determinism and verification.** The model is built in sorted-id order
  over a deterministic simplex, so shuffled inputs give identical results
  (property-tested), and a brute-force reference in
  `allocate.property.test.ts` holds the LP to the true optimum on every
  small problem it can enumerate.

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

- **Node.js 24** (see `.nvmrc`). With [fnm](https://github.com/Schniz/fnm),
  `fnm use` in this directory picks it up automatically.
- **pnpm 11** via [Corepack](https://nodejs.org/api/corepack.html): run
  `corepack enable` once and `pnpm` resolves to the exact version pinned in
  `package.json`'s `packageManager` field. Corepack shims are per Node
  install — if you switch Node versions, run `corepack enable` again.
- Everything else (TypeScript, vitest, fast-check, tsx) arrives with
  `pnpm install`. Note the repo pins **TypeScript 7.x**, not the more
  common 5.x — intentional, not a typo.

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

The output lists trades grouped by account (sells before buys, each with
its reason), a per-asset-class table of current → target → trades → final
value with the remaining deviation, a per-account breakdown of every
position's current/traded/final value (so you can check the starting
numbers against your real accounts, and the final ones after trading), and
any warnings. Warnings are reserved for actionable problems — e.g. a
targeted asset class no funded account offers — not for ordinary
"contribution wasn't enough" shortfalls, which the tables already show.

## Scope

Built so far: the domain types, the LP solver (buy-only by default, opt-in
selling with tax-aware guards and tolerance bands), the canonical JSON
scenario format with `validateScenario()`, the test suite (golden fixtures,
invariant and property-based tests, a brute-force optimality check on the
allocator), the CLI, and a local-only web UI ([WEB_UI.md](WEB_UI.md)) that
builds and edits scenarios, solves live, and saves/loads the canonical
JSON, including a per-fund blend editor for multi-class funds.

Not built yet: CSV/brokerage-export parsing, prices/shares/cost-basis (a
holding is just fund → dollars), and capital-gains-aware sell selection.

## CI

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run test` on every push.
