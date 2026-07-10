# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
pnpm install                    # install deps (use over adding deps by hand)
pnpm run typecheck              # tsc --noEmit in every package
pnpm run test                   # vitest run in every package (single run)
pnpm --filter @rebalancer/solver test -- rebalance   # run a single test file/pattern
pnpm run test:watch             # vitest in watch mode, solver package only
pnpm run build                  # compile every package to dist/
pnpm solve -p <scenario.json> [--sell] [--sell-taxable] [-c accountId:amountCents ...]   # run the CLI
```

Node version is pinned in `.nvmrc` (24); run `fnm use` before working. CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run test` on every push.

## Architecture

pnpm workspace (`pnpm-workspace.yaml`) with two packages:

- **`packages/solver`** — the rebalancing engine. Pure TypeScript: no DOM, no `fetch`, no filesystem access, no network calls. Deterministic — same input always produces the same output. Its public exports are `rebalance()`, `validateScenario()`, `DEFAULT_TOLERANCE_BPS`, and the domain types in `src/types.ts`; nothing else in `src/` should be imported from outside the package.
  - `src/rebalance.ts` — orchestration: validates input, reduces it to a transportation problem, delegates placement to `allocate()`, translates the resulting per-(account × asset class) deltas into buy/sell `Trade`s with human reasons, and formats warnings. The algorithm (greedy waterfall: buy pass, then opt-in sell pass, governed by a tolerance band) is explained in a comment block at the top. It also does all semantic input validation (targets summing to 10000 bps, referential integrity of ids, non-negative integers) — the solver is the trust boundary, so callers don't need to re-validate.
  - `src/allocate.ts` — the optimizer seam. `allocate(problem)` works purely in (account × asset class) space — ids and integer cents; no funds, no names. Money never leaves an account, so each account's post-trade total is fixed (a fixed-supply transportation problem). The greedy implementation can be swapped for an LP-backed one (e.g. `glpk.js` or `jsLPSolver`) by replacing this one function; `src/allocate.property.test.ts` brute-forces small problems to pin the optimality bar any replacement must clear. Do not hand-roll a min-cost-flow solver.
  - `src/scenario.ts` — `validateScenario(unknown): Scenario` structurally validates an untrusted parsed JSON document (field presence, primitive types, enum membership, unknown-key rejection; keys starting with `_` are ignored as comments). Semantic rules stay in `rebalance()`.
  - `fixtures/example.json` (buy-only golden: a hand-invented household — taxable brokerage, two IRAs, a 401(k), an HSA) and `fixtures/sell-required.json` (selling golden: a drifted portfolio only fixable by selling) are placeholder data, not real portfolios. Both are complete `Scenario` documents — the same shape the CLI reads.
  - `package.json` `main`/`types`/`exports` point directly at `src/index.ts` (not `dist/`) so workspace consumers (the CLI, via `tsx`) don't need a build step in dev. `pnpm run build` still produces a real `dist/` for whenever this is published.
- **`apps/cli`** — thin wrapper around the solver, run with `tsx` and `node:util`'s `parseArgs`. It only imports `@rebalancer/solver`'s public API (never reaches into `packages/solver/src` directly), and does all the I/O the solver isn't allowed to do (reading the scenario JSON file from disk). `-p` loads a whole `Scenario` (portfolio + targets + contributions + options); flags are overrides (`-c` replaces the file's contributions; `--sell`, `--sell-taxable`, `--tolerance-bps`, `--min-trade-cents` adjust options).

Money is always an integer number of cents (never a float). Weights/targets are always integer basis points 0–10000 (never a 0–1 fraction).

- Tests are colocated as `*.test.ts` next to the code they cover, run with vitest.
- Property tests use `fast-check`: `src/rebalance.property.test.ts` (no sells without `allowSelling`, per-account conservation `buys − sells == contribution`, never selling a class below target, taxable-sell guard, determinism under shuffled input ordering) and `src/allocate.property.test.ts` (greedy matches a brute-force minimum-deviation reference on single-account problems, and reaches target exactly when unconstrained).
- Each package's `vitest.config.ts` restricts test discovery to `src/**/*.test.ts` — without this, vitest also picks up compiled `*.test.js` files under the git-ignored `dist/`, double-running every test after a local build. Keep this scoping if touching vitest config.
- TypeScript (`tsconfig.base.json` at the repo root, extended per-package) uses `module: nodenext` + `verbatimModuleSyntax`, so relative imports must include the `.ts` extension (e.g. `import { rebalance } from "./rebalance.ts"`) — this is intentional, not an error to "fix". `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` are on so this works both for `tsc --noEmit` and for real builds (which rewrite `.ts` → `.js` in emitted output).

## Domain model notes (not obvious from the code alone)

- `Contribution { accountId, amount }` is cash **earmarked to a specific account** — money never moves between accounts (mirrors reality: a 401(k) payroll contribution can't land in an IRA). The CLI's `-c` flag is therefore `accountId:amountCents`, repeatable, not a single bare number. The same constraint applies to selling: cash raised by a sell can only buy funds in that same account, which is what keeps the allocation problem account-local.
- `Account.availableFundIds` is **ordered, most-preferred first**: buys pick the earliest fund of the target asset class, leftover contribution cash falls back to `availableFundIds[0]`, and sells liquidate the *least*-preferred fund of the class first (a held fund absent from the list — "held but no longer buyable" — is treated as least preferred of all). There is no separate fund-preference field.
- `AssetClass.taxPreference` (`prefer_taxable` | `prefer_tax_advantaged` | `neutral`) ranks which accounts should be preferred when more than one is eligible to receive a given asset class (e.g. bonds default to `prefer_tax_advantaged`). This field isn't in most "textbook" domain models — it exists because the household in `fixtures/example.json` needed a simple way to express asset-location preference without a separate ranking table. Sells have their own rule: prefer tax-advantaged accounts (no tax consequence), and never sell in taxable accounts at all unless `sellInTaxableAccounts` is set.
- The tolerance band (`toleranceBps`, default 50) is the stand-in for the NP-hard "minimize number of trades" objective: a class within ±band of target is treated as on-target — not bought toward, not used as a sell donor, not "fixed" by selling, not warned about. `minTradeCents` floors sell-funded moves only; contribution cash is always fully invested because cash may not sit idle in an account.
