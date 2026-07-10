# Plan: selling support, `fundPreference` merge, JSON scenario format, CLI

## Context

Today the rebalancer is **buy-only**: a greedy waterfall spends new contribution
cash to move a portfolio *toward* target, never selling. That's safe but it
frequently can't reach target in one run — the example fixture emits 4
"unreachable gap" warnings. Real rebalancing usually needs to **sell**
overweight positions and rotate within an account.

This plan evolves the engine to support selling, and does it in a way that stays
compatible with a future web UI (the stated end goal) without building the UI
yet. Concretely:

1. **Merge `fundPreference` into `availableFundIds`.** They're redundant — the
   only real difference anywhere in the fixture is a reordering. Collapse to one
   ordered (most-preferred-first) list. Do this first; it simplifies the model
   the UI will render.
2. **Add selling** via a non-greedy **min-cost transportation/flow** solver
   (the greedy waterfall can't express "sell X here to buy Y there"). Selling is
   minimized and steered toward tax-advantaged accounts first (no tax
   consequence), per the domain intent. We are **not** tracking prices, shares,
   or cost basis yet — within each account a holding is just `fund → dollars`.
3. **Tolerance bands** as the governor on selling and trade count (see rationale
   below — this answers "what's the point").
4. **A single canonical JSON scenario document** that is the complete input
   (portfolio + targets + contributions + options), so the CLI reads one file
   and a future UI can save/load the exact same shape.
5. **CLI**: read the whole scenario from that JSON file (it already reads a JSON
   file via `-p`, but contributions/options currently live in flags and the
   fixture's `contributions` key is silently ignored — this fixes that), and
   print buys **and** sells plus the resulting allocation/deviation that the
   solver already computes but the CLI currently discards.

Scope: **solver + CLI only. No web UI, no CSV.** JSON is the one format.

---

## Design decisions (call these out for approval)

- **One unified solver, not two.** `rebalance()` stays the single entry point;
  buy-only becomes `allowSelling: false` (sell pass skipped). Rationale: a future
  UI wants one clean function + one options object, not two divergent code paths.
  **Consequence:** buy-only mode runs only the existing buy pass, so today's
  golden test should stay essentially valid (modulo the Part 1
  `fundPreference`/HSA-reorder tweak). The new selling behavior gets its own
  golden fixture, backed by a brute-force near-optimality property test (see
  Testing).
- **Greedy now, LP-swappable later.** The allocation step sits behind a clean
  internal seam (`allocate(problem)`), implemented greedily now; an LP-backed
  implementation can replace that one function later without touching callers,
  the `Scenario` format, the CLI, or the tests. **No hand-rolled min-cost flow.**
- **No prices/shares/cost basis.** Money stays integer cents; a holding is
  `fund → value`. Selling is expressed in dollars.
- **Money never leaves an account** (unchanged). So each account's post-trade
  total is *fixed* = its current holdings + its contribution. This is what makes
  the problem a transportation problem (fixed supplies per account).

---

## Part 1 — Merge `fundPreference` into `availableFundIds`

`fundPreference` does real work in only two spots (`pickFund` at
`packages/solver/src/rebalance.ts:282`, and the leftover-cash fallback at
`:181`), and no account in the fixture even holds two funds of the same asset
class, so `pickFund`'s tie-break never fires. Redefine `availableFundIds` as
**ordered, most-preferred first** and delete `fundPreference`.

- `packages/solver/src/types.ts`: remove `fundPreference` from `Account`;
  document `availableFundIds` ordering.
- `packages/solver/src/rebalance.ts`: fund selection for a buy = first entry of
  `availableFundIds` whose fund is in the target class; fallback fund =
  `availableFundIds[0]`. Drop the `fundPreference` referential check in
  `validate()` (`:336`).
- `packages/solver/fixtures/example.json`: delete every `fundPreference`;
  reorder HSA's `availableFundIds` to `["vti","avuv","vxus"]` to preserve its old
  intent.
- Tests reference `Account` shape (`rebalance.test.ts`,
  `rebalance.property.test.ts` `ExampleFixture`) — no code change needed once the
  field is gone from the type and fixture, but re-run to confirm.
- Note: "held but not buyable" is already expressible via `holdings` referencing
  a fund not in `availableFundIds`; merging loses no expressiveness.

---

## Part 2 — Selling: two-phase greedy behind a clean optimizer seam

Because **money never leaves an account**, we don't need a global min-cost-flow
solver: selling in account A can only fund buys in account A. So *extend* the
existing, tested greedy waterfall to sell rather than replacing it with a flow
algorithm — and put the allocation step behind a seam so an LP optimizer can be
dropped in later.

**The seam.** `rebalance()` orchestrates; the allocation math is delegated:
- `rebalance()`: validate → compute per-account fixed totals `T[a] = Σ holdings
  in a + contribution[a]` and target dollars `G[c] = proportionalAllocate(
  newTotal, targets)` (reuse the helper at `rebalance.ts:245`) → apply the
  tolerance band → call `allocate(problem)` → translate its result into `Trade`s.
- `allocate(problem)` — new internal `packages/solver/src/allocate.ts`. Input is
  a `TransportationProblem` `{ supplies T[a], demands G[c], current H[a][c],
  buyable(a,c), sellable(a,c) caps }`; output is `x[a][c]` (final dollars per
  account/class). Swapping in an LP-backed `allocate()` later is a single-file
  change with the same signature — no other code moves.

**Greedy `allocate` — two phases** (integer cents, tie-broken by id):
1. **Buy pass** — the existing waterfall: spend each account's contribution cash
   to close underweight gaps. With `allowSelling: false` this is the *only* pass,
   preserving today's behavior.
2. **Sell-to-fund pass** — for each class still underweight beyond the band
   (largest gap first), find accounts that can *buy* it and hold an *overweight*
   class; sell the overweight position to raise account-local cash, then buy the
   underweight one within that same account. Prefer tax-advantaged accounts.
   Cap each sell by the global excess of the sold class (`C[c] − G[c]`, tracked
   as a shrinking budget) so a class is never sold below target, and by the
   underweight remaining so we never raise cash we can't redeploy.

This is greedy, so it can be marginally suboptimal in contrived cross-account
cases; with a 0.5% band the gap from optimal is immaterial for realistic
portfolios. If that ever stops being true, replace `allocate()` with an
LP-backed implementation (see Out of scope) — nothing else changes.

**Hard guard:** `sellInTaxableAccounts` (default `false`) → `sellable(a,c) = 0`
for taxable accounts, so by default we only rebalance within tax-protected
accounts and via contributions; taxable positions are never trimmed. When target
can't be reached under that guard, warn (same pattern as today's unreachable-gap
warnings).

**Translate allocation → `Trade`s** in `rebalance.ts`:
- `x[a][c] − H[a][c] > 0` → **buy** that delta of the preferred available fund
  for c in a (Part 1 ordering).
- `< 0` → **sell** `|delta|` from held funds of c in a; if several funds share
  the class, sell least-preferred first.
- `Trade.action` widens to `"buy" | "sell"`; each trade keeps a human `reason`.

---

## Part 3 — Tolerance bands (rationale: why they exist)

Once selling is exact-optimizing, the solver will otherwise churn the whole
portfolio to the penny every run — a $3 sell to fix a 0.02% drift. Bands are the
governor:

- **`toleranceBps`** — if a class is within ±band of its target, treat it as
  on-target (don't generate trades to "fix" it). This is the pragmatic stand-in
  for the genuinely NP-hard "minimize number of trades" objective, and it's how
  ordinary drift gets absorbed by contributions instead of triggering sells.
- **`minTradeCents`** — drop any individual trade below this size.

`toleranceBps` defaults to a sensible non-zero constant — **50 bps (0.5%)** —
so out of the box the solver ignores trivial drift instead of churning; callers
can override (0 = exact). `minTradeCents` defaults to 0. Both are applied as a
filter around the solve. This is the lever that keeps trade count and selling
low without solving an integer program.

---

## Part 4 — Types / API (UI-compatible)

`packages/solver/src/types.ts`:
- `Trade.action: "buy" | "sell"`.
- `RebalanceOptions`: add `allowSelling?: boolean` (default `false`),
  `sellInTaxableAccounts?: boolean` (default `false`), `toleranceBps?: number`
  (**default 50** — a `DEFAULT_TOLERANCE_BPS` constant, 0.5%),
  `minTradeCents?: number` (default 0). Keep `contributions`.
- New exported **`Scenario`** type = the complete input document:
  `{ portfolio: { assetClasses, funds, accounts, holdings }, targets, contributions, options? }`.
  This is the shape the CLI reads and a future UI saves/loads.
- `RebalanceResult` shape unchanged (`trades`, `resultingAllocation`,
  `deviationFromTarget`, `warnings`); warnings extended for the new
  "couldn't reach target without selling in taxable" case.

`packages/solver/src/index.ts`: export `Scenario` and any new option types.

Keep IO out of the pure solver. Add a pure `validateScenario(scenario)` (or fold
into existing `validate`) so both CLI and a future UI share one validated
document shape — the solver stays the trust boundary.

---

## Part 5 — CLI

`apps/cli/src/index.ts`:
- `-p <scenario.json>` now loads the **whole** `Scenario` (portfolio + targets +
  contributions + options) from one JSON file — resolving today's wart where the
  fixture's `contributions` key is ignored and contributions only come from
  flags.
- Flags become optional overrides: `-c accountId:cents` (repeatable; if present,
  replaces file contributions), `--sell` (sets `allowSelling`),
  `--sell-taxable`, `--tolerance-bps <n>`, `--min-trade-cents <n>`.
- Output: print buys **and** sells (grouped by account), then the
  `resultingAllocation` and `deviationFromTarget` tables (already computed by the
  solver, currently discarded at `index.ts:60`), then warnings — so you can see
  "sell X, buy Y" and exactly where you land.

---

## Files touched

- `packages/solver/src/types.ts` — Account (drop `fundPreference`), `Trade`
  action union, `RebalanceOptions` new fields, new `Scenario` type.
- `packages/solver/src/rebalance.ts` — orchestrate: build the transportation
  problem, delegate to `allocate()`, translate the allocation into buy/sell
  trades, apply band / min-trade filter; update `validate`.
- `packages/solver/src/allocate.ts` (new) — internal `allocate()` +
  `TransportationProblem` type (the greedy two-phase implementation and the
  LP-swap seam) + colocated `allocate.test.ts` (new).
- `packages/solver/src/index.ts` — export new types.
- `packages/solver/fixtures/example.json` — drop `fundPreference`, reorder HSA;
  optionally add an `options` block.
- `packages/solver/fixtures/sell-required.json` (new) — a fixture that only
  reaches target by selling, for the selling golden test.
- `packages/solver/src/rebalance.test.ts` — re-derive buy-only golden as a
  computed snapshot; add a selling golden.
- `packages/solver/src/rebalance.property.test.ts` — gate "never sells" behind
  `allowSelling:false`; update per-account conservation to
  `buys − sells == contribution`; add brute-force optimality property;
  keep determinism-under-shuffle.
- `apps/cli/src/index.ts` — full-scenario load, override flags, richer output.
- `README.md`, `CLAUDE.md` — document the merge, selling + options, the JSON
  scenario format, new CLI flags. Update the "Scope"/domain-model sections.

---

## Testing / verification

- `pnpm run typecheck` and `pnpm run test` clean.
- **Determinism** (existing property) still holds — flow solver tie-breaks by id.
- **Per-account conservation** (updated): within each account,
  `Σ buys − Σ sells == contribution[account]`.
- **No-sell mode**: with `allowSelling:false`, `trades.every(t => t.action==="buy")`.
- **Near-optimality property** (new): on small random portfolios, a brute-force
  reference over the tiny space confirms greedy `allocate()` lands within the
  tolerance band of the minimum-deviation optimum and never sells a class below
  target. A sanity bound, not an exact match — this backs the selling golden and
  gives us confidence to later swap in an LP `allocate()` and compare.
- **Selling guard**: with `sellInTaxableAccounts:false`, no `sell` trade lands in
  a `taxable` account.
- **End-to-end CLI**: `pnpm solve -p packages/solver/fixtures/example.json`
  (buy-only) and `pnpm solve -p packages/solver/fixtures/sell-required.json --sell`
  — inspect that it prints sells + buys, the resulting allocation matches target
  within the band, and deviation is reported.

## Out of scope (future)

Web UI; CSV; prices/shares/cost-basis and capital-gains-aware selling; exact
minimum-trade-count optimization (approximated here by tolerance bands). An
**LP-backed `allocate()`** for provable optimality is explicitly deferred: the
seam is in place, so if greedy proves insufficient, drop in a library
(`glpk.js` WASM, or pure-JS `jsLPSolver`) behind the same `allocate()` signature
and swap that one function. Not hand-rolled flow.
