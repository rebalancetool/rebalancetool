# The web UI (`apps/web`)

A React single-page app over `@rebalancer/solver`: build a portfolio and
targets in the browser, watch the solver's trades update live, download the
whole thing as a JSON file. There is **no backend and no storage** — all
state lives in the page, and reloading clears it (that's by design; the
JSON download is the persistence story).

## Run it locally

```
pnpm install     # once, at the repo root (Node 24 — run `fnm use` first)
pnpm dev         # start the Vite dev server
```

Then open **http://localhost:5173**. The page starts with a small
catalog of common index funds and their asset classes
(`starter-scenario.ts`) — an editable convenience, deliberately with
**no accounts, holdings, or target percentages**: pre-filling those
could read as a suggested portfolio, and the compliance posture is that
every dollar amount and percentage on screen was stated by the user.
The header's "How it works" steps and short hints beside each control
point the way; to see a fully populated run, load any fixture from
`packages/solver/fixtures/` via **Open file…** (the UI tests drive a
populated household through App's `initialScenario` prop).

To test a production build instead of the dev server:

```
pnpm --filter @rebalancer/web run build
pnpm --filter @rebalancer/web exec vite preview   # serves dist/ on http://localhost:4173
```

Tests and types:

```
pnpm run test        # all packages, including the web app's vitest + testing-library suite
pnpm run typecheck
pnpm --filter @rebalancer/web run test:watch
```

## Icons & wordmark

The favicon, touch icon, and header wordmark are hand-drawn SVGs in
`apps/web/public/`. Raster fallbacks (`favicon.ico`, `icon-192.png`,
`icon-512.png`, `apple-touch-icon.png`) are generated from them with
`pnpm icons` (sharp, entirely local) and committed — regenerate and
re-commit after editing an SVG. `site.webmanifest` and the `<link>`
tags live in `index.html`.

## Deploying

The app is a fully static Vite build — no backend, no environment
variables, no redirects — so any static host works.

It's currently deployed to Cloudflare as a **static-assets Worker**
(Cloudflare has quietly buried the classic Pages create flow; new git
imports land in Workers Builds). `wrangler.jsonc` at the repo root is the
whole config: no `main`/server code, no bindings, just
`assets.directory: apps/web/dist`. Git-integrated Workers Builds settings:

| Setting        | Value                                     |
| -------------- | ----------------------------------------- |
| Build command  | `pnpm --filter @rebalancer/web run build` |
| Deploy command | `npx wrangler deploy` (the default)       |
| Root directory | `/` (the repo root)                       |

`npx wrangler deploy --dry-run` validates the config locally without
auth. The classic **Pages** path still works identically if you can find
it (Workers & Pages → Pages → Connect to Git) — it takes no deploy
command and a `Build output directory` of `apps/web/dist` instead of
`wrangler.jsonc`.

The deploy silently depends on repo properties that must stay true —
keep these consistent when changing the build:

- **Install must run at the repo root.** `@rebalancer/web` depends on
  `@rebalancer/solver` via `workspace:*`, which only resolves with the
  root `pnpm-lock.yaml`. Never point a host's "root directory" at
  `apps/web`.
- **The solver is consumed from `src/`, not `dist/`.** Its
  `main`/`exports` point at `src/index.ts`, so `vite build` compiles the
  solver's TypeScript itself and no pre-build step exists in the deploy
  command. If the solver ever ships from `dist/`, every deploy config
  needs a solver build added in front.
- **`.nvmrc` and `package.json`'s `packageManager` are the toolchain
  pins hosts read** (Node version, exact pnpm via corepack). Keep them
  current; a host that ignores `.nvmrc` needs a `NODE_VERSION` env var
  instead.
- **Vite's `base` is the default `/`**, so built asset URLs are
  absolute from the domain root. Fine for `*.pages.dev` or any custom
  domain; serving under a subpath would require setting `base` in
  `vite.config.ts`.
- **There is one page and no client-side routing**, so no SPA rewrite
  rules (`_redirects`) are needed. Adding a router later means adding
  them.
- Pages deploys on every push to `main`, independent of GitHub Actions
  CI — branch protection (merged PRs only) is what keeps unreviewed
  code off production.

## What it does

The page is one screen, top to bottom:

1. **Portfolio** — the builder. Asset classes (name, tax preference, and
   each class's target share, with a live "must total 100%" total line);
   funds (ticker, optional full name, asset class — or a *blend*: the class
   dropdown's "Blend of classes…" option expands a slice-by-slice editor
   with its own "must total 100%" check, and a multi-class fund shows a
   compact "Blend ▾" toggle — hover it for the mix — that opens that
   editor; removing a blend's last-but-one slice bumps the survivor back to
   100% and the row collapses to a plain dropdown); and one card per
   account: its tax type, just the funds in that account — the buyable
   menu in preference order (#1 is bought first and receives leftover
   cash; the ordered list is the solver's only fund-preference input) with
   each position's current dollar value — and a "Cash to invest" line for
   the account's contribution (account-scoped, because money never moves
   between accounts). Drag a row's grip to reorder (the handle is a real
   button: space to lift, arrows to move, space to drop); the ＋ Add fund…
   picker appends a fund as least-preferred, and ✕ removes a fund from the
   account (menu entry and holding). Removals cascade — deleting an asset
   class deletes its funds, their holdings, menu entries, and its target —
   so the document always stays referentially intact.
2. **Results** — recomputed by `rebalance()` on every edit. Trades grouped
   by account with each trade's human-readable reason shown in full, the
   portfolio-by-asset-class table (current → target → trades → final →
   vs target), per-account before/after position tables, and any warnings.
   If the current inputs are invalid (targets don't total 100%, say), the
   solver's own error message renders where the results would be.

Selling is **on by default** in the UI (the solver itself stays buy-only
by default) — but never in taxable accounts, where sells could realize
capital gains, until the user opts in. All the knobs — allow selling,
allow selling in taxable accounts, optimize asset location, tolerance
band, minimum sell-funded trade — live behind ⚙ Settings (one button in
the header, one in the status bar). "Optimize asset location"
(`options.optimizeAssetLocation`, off by default) makes the solver
relocate asset classes into the account types their tax preference
names even when the allocation is already on target; like taxable
selling it implies "allow selling", and turning selling off clears both
dependent flags (`withOptions` keeps them coherent). It deliberately
does *not* imply "allow selling in taxable accounts" — that's the one
setting with capital-gains consequences, so it stays an explicit opt-in;
instead, when that guard is all that blocks better placement, the
solver's warnings say exactly how many dollars of which class could
move (a counterfactual computed by the solver — the UI just renders
it). The status bar
between the editor and the results carries the recompute pulse plus a
settings summary that always states the selling posture ("selling on ·
taxable accounts protected" / "may sell in taxable accounts" / "selling
off") and lists any other non-default knobs — including "optimizing
asset location" — so tucked-away settings can never invisibly shape the
results.

A permanent footer carries the compliance disclaimer: the tool is a
calculator performing arithmetic on user-supplied inputs, not
personalized investment advice, and data never leaves the browser. Keep
it visible on every layout change — presenting impersonal calculation
(rather than security recommendations) is a legal posture, not just
copy. It also carries the open-source attribution (MIT, with GitHub
source/issues links); those links open in a new tab because navigating
away would discard the page's unsaved state.

**Save file / Open file…** in the header save and restore the complete
scenario. The file is the solver's canonical `Scenario` document — exactly
what the CLI reads — so a downloaded file works directly with
`pnpm solve -p <file>`, and any fixture in `packages/solver/fixtures/`
loads straight into the UI. Downloads carry an `"_format":
"rebalancetool-scenario-v1"` comment key (the validator ignores
`_`-prefixed keys) so future format changes can recognize old files.

## How it's built

- One state object: the whole `Scenario` lives in a single React
  `useState`; every editor edits it through pure updater functions
  (`scenario-edit.ts`) that are unit-tested without the DOM.
- The UI computes nothing about money. It calls only the solver's public
  API (`rebalance`, `validateScenario`) and renders what comes back; there
  are no rollups, gap calculations, or placement decisions in the React
  code. Money is integer cents end to end — typed text is parsed to cents
  textually (`parse.ts`, no float math) and formatted to dollars only at
  render (`format.ts`).
- No network calls, no `localStorage`/`sessionStorage`, no `<form>`
  submits. Market values come from user input, always.
- Tests are colocated `*.test.ts(x)` files run by vitest with
  testing-library in jsdom: pure-function tests for parsing and scenario
  updates, rendering tests against hand-written `RebalanceResult`s, and
  end-to-end user-event flows (build a portfolio from a blank page and see
  the solver's trade appear; upload a file; break the targets total and
  recover).

## Not built (yet)

CSV/brokerage-export import with fund→asset-class mapping, URL-hash state
sharing, copy-trades-as-text/CSV export, and prices/shares/cost basis
(a holding is just fund → dollars, as in the solver).
