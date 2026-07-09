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
pnpm solve -p <scenario.json> -c accountId:amountCents [-c ...]   # run the CLI
```

Node version is pinned in `.nvmrc` (24); run `fnm use` before working. CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run test` on every push.

## Architecture

pnpm workspace (`pnpm-workspace.yaml`) with two packages:

- **`packages/solver`** — the rebalancing engine. Pure TypeScript: no DOM, no `fetch`, no filesystem access, no network calls. Deterministic — same input always produces the same output. Its only public export is `rebalance()` plus the domain types in `src/types.ts`; nothing else in `src/` should be imported from outside the package. The algorithm (a buy-only greedy waterfall) is explained in a comment block at the top of `src/rebalance.ts`.
  - `src/rebalance.ts` also does all input validation (targets summing to 10000 bps, referential integrity of ids, non-negative integers) — the solver is the trust boundary, so callers don't need to re-validate.
  - `fixtures/example.json` is a hand-invented household (taxable brokerage, two IRAs, a 401(k), an HSA; BND/BNDX/VTI/VXUS/AVUV) used by the golden test in `src/rebalance.test.ts`. It is placeholder data, not a real portfolio.
  - `package.json` `main`/`types`/`exports` point directly at `src/index.ts` (not `dist/`) so workspace consumers (the CLI, via `tsx`) don't need a build step in dev. `pnpm run build` still produces a real `dist/` for whenever this is published.
- **`apps/cli`** — thin wrapper around the solver, run with `tsx` and `node:util`'s `parseArgs`. It only imports `@rebalancer/solver`'s public API (never reaches into `packages/solver/src` directly), and does all the I/O the solver isn't allowed to do (reading the scenario JSON file from disk).

Money is always an integer number of cents (never a float). Weights/targets are always integer basis points 0–10000 (never a 0–1 fraction).

- Tests are colocated as `*.test.ts` next to the code they cover, run with vitest.
- Property tests use `fast-check` (`src/rebalance.property.test.ts`): no sells, per-account contribution conservation, and determinism under shuffled input array ordering.
- Each package's `vitest.config.ts` restricts test discovery to `src/**/*.test.ts` — without this, vitest also picks up compiled `*.test.js` files under the git-ignored `dist/`, double-running every test after a local build. Keep this scoping if touching vitest config.
- TypeScript (`tsconfig.base.json` at the repo root, extended per-package) uses `module: nodenext` + `verbatimModuleSyntax`, so relative imports must include the `.ts` extension (e.g. `import { rebalance } from "./rebalance.ts"`) — this is intentional, not an error to "fix". `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` are on so this works both for `tsc --noEmit` and for real builds (which rewrite `.ts` → `.js` in emitted output).

## Domain model notes (not obvious from the code alone)

- `Contribution { accountId, amount }` is cash **earmarked to a specific account** — money never moves between accounts (mirrors reality: a 401(k) payroll contribution can't land in an IRA). The CLI's `-c` flag is therefore `accountId:amountCents`, repeatable, not a single bare number.
- `AssetClass.taxPreference` (`prefer_taxable` | `prefer_tax_advantaged` | `neutral`) ranks which accounts should be preferred when more than one is eligible to receive a given asset class (e.g. bonds default to `prefer_tax_advantaged`). This field isn't in most "textbook" domain models — it exists because the household in `fixtures/example.json` needed a simple way to express asset-location preference without a separate ranking table.
