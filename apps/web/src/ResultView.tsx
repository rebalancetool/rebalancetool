import type { RebalanceResult, Scenario, TaxType, Trade } from "@rebalancer/solver";
import { formatCents, formatDelta, formatSignedBpsAsPercent } from "./format.ts";

/**
 * Renders a RebalanceResult. Pure presentation: every number displayed here
 * was computed by the solver — this file must never do money math beyond
 * formatting. Mirrors the CLI's output structure (trades grouped by account,
 * allocation vs target, per-account before/after), which is the approved UX.
 *
 * The solver's output is deliberately ordered by account *id* (an
 * order-independence invariant); presentation reorders the account sections
 * to the scenario's account order, so results line up positionally with the
 * editor above them.
 */

const TAX_TYPE_LABELS: Record<TaxType, string> = {
  taxable: "Taxable",
  tax_deferred: "Tax-deferred",
  tax_free: "Tax-free",
};

interface Lookups {
  accountName: (id: string) => string;
  accountTaxType: (id: string) => TaxType | undefined;
  /** Position of the account in the scenario document — the editor's order. */
  accountRank: (id: string) => number;
  fundLabel: (id: string) => string;
  fundName: (id: string) => string;
  className: (id: string) => string;
}

function buildLookups(scenario: Scenario): Lookups {
  const accounts = new Map(scenario.portfolio.accounts.map((a) => [a.id, a]));
  const rankByAccountId = new Map(scenario.portfolio.accounts.map((a, index) => [a.id, index]));
  const funds = new Map(scenario.portfolio.funds.map((f) => [f.id, f]));
  const classes = new Map(scenario.portfolio.assetClasses.map((c) => [c.id, c]));
  return {
    accountName: (id) => accounts.get(id)?.name ?? id,
    accountTaxType: (id) => accounts.get(id)?.taxType,
    accountRank: (id) => rankByAccountId.get(id) ?? rankByAccountId.size,
    fundLabel: (id) => {
      const fund = funds.get(id);
      return fund?.ticker || fund?.name || id;
    },
    fundName: (id) => funds.get(id)?.name ?? id,
    className: (id) => classes.get(id)?.name ?? id,
  };
}

function AccountHeading({ name, taxType }: { name: string; taxType: TaxType | undefined }) {
  return (
    <h3 className="account-heading">
      {name}
      {taxType && <span className={`chip chip-${taxType}`}>{TAX_TYPE_LABELS[taxType]}</span>}
    </h3>
  );
}

/**
 * Trades arrive from the solver sorted by account id (sells before buys);
 * group consecutive runs. The caller reorders the groups for display.
 */
function groupTradesByAccount(trades: Trade[]): { accountId: string; trades: Trade[] }[] {
  const groups: { accountId: string; trades: Trade[] }[] = [];
  for (const trade of trades) {
    const last = groups[groups.length - 1];
    if (last && last.accountId === trade.accountId) {
      last.trades.push(trade);
    } else {
      groups.push({ accountId: trade.accountId, trades: [trade] });
    }
  }
  return groups;
}

// The settings summary that used to sit beside this heading lives in App's
// status bar now (describeOptions in format.ts), directly above this section.
function TradesSection({ result, lookups }: { result: RebalanceResult; lookups: Lookups }) {
  if (result.trades.length === 0) {
    return (
      <section aria-labelledby="trades-heading">
        <h2 id="trades-heading">Trades</h2>
        <p className="empty-note">No trades needed — every asset class is within its tolerance band.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="trades-heading">
      <h2 id="trades-heading">Trades</h2>
      {groupTradesByAccount(result.trades)
        .sort((a, b) => lookups.accountRank(a.accountId) - lookups.accountRank(b.accountId))
        .map((group) => (
        <div className="card" key={group.accountId}>
          <AccountHeading
            name={lookups.accountName(group.accountId)}
            taxType={lookups.accountTaxType(group.accountId)}
          />
          <ul className="trade-list">
            {group.trades.map((trade, i) => (
              <li className={`trade trade-${trade.action}`} key={i}>
                <span className="trade-action">{trade.action === "sell" ? "SELL" : "BUY"}</span>
                <span className="trade-fund">
                  <strong>{lookups.fundLabel(trade.fundId)}</strong>
                  <span className="trade-fund-name">{lookups.fundName(trade.fundId)}</span>
                </span>
                <span className="trade-amount num">{formatCents(trade.amount)}</span>
                <p className="trade-reason">{trade.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function AllocationSection({ result, lookups }: { result: RebalanceResult; lookups: Lookups }) {
  const deviationByClassId = new Map(result.deviationFromTarget.map((d) => [d.assetClassId, d.deviationBps]));
  return (
    <section aria-labelledby="allocation-heading">
      <h2 id="allocation-heading">Portfolio by asset class</h2>
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Asset class</th>
              <th scope="col" className="num-col">Current</th>
              <th scope="col" className="num-col">Target</th>
              <th scope="col" className="num-col">Trades</th>
              <th scope="col" className="num-col">Final</th>
              <th scope="col" className="num-col">vs target</th>
            </tr>
          </thead>
          <tbody>
            {result.resultingAllocation.map((entry) => {
              const vsTarget = entry.value - entry.targetValue;
              const deviationBps = deviationByClassId.get(entry.assetClassId) ?? 0;
              return (
                <tr key={entry.assetClassId}>
                  <th scope="row">{lookups.className(entry.assetClassId)}</th>
                  <td className="num-col">{formatCents(entry.currentValue)}</td>
                  <td className="num-col">{formatCents(entry.targetValue)}</td>
                  <td className="num-col">{formatDelta(entry.value - entry.currentValue)}</td>
                  <td className="num-col">{formatCents(entry.value)}</td>
                  <td className="num-col">
                    {vsTarget === 0 ? (
                      <span className="on-target">on target</span>
                    ) : (
                      `${formatDelta(vsTarget)} (${formatSignedBpsAsPercent(deviationBps)})`
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AccountsSection({ result, lookups }: { result: RebalanceResult; lookups: Lookups }) {
  return (
    <section aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Accounts</h2>
      {[...result.accounts]
        .sort((a, b) => lookups.accountRank(a.accountId) - lookups.accountRank(b.accountId))
        .map((breakdown) => (
        <div className="card" key={breakdown.accountId}>
          <AccountHeading
            name={lookups.accountName(breakdown.accountId)}
            taxType={lookups.accountTaxType(breakdown.accountId)}
          />
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Fund</th>
                  <th scope="col" className="num-col">Current</th>
                  <th scope="col" className="num-col">Trades</th>
                  <th scope="col" className="num-col">Final</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.positions.map((position) => (
                  <tr key={position.fundId}>
                    <th scope="row">{lookups.fundLabel(position.fundId)}</th>
                    <td className="num-col">{formatCents(position.currentValue)}</td>
                    <td className="num-col">{formatDelta(position.tradeDelta)}</td>
                    <td className="num-col">{formatCents(position.finalValue)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <th scope="row">
                    total
                    {breakdown.contribution > 0 && (
                      <span className="cash-in"> (+{formatCents(breakdown.contribution)} cash in)</span>
                    )}
                  </th>
                  <td className="num-col">{formatCents(breakdown.currentTotal)}</td>
                  <td className="num-col">{formatDelta(breakdown.finalTotal - breakdown.currentTotal)}</td>
                  <td className="num-col">{formatCents(breakdown.finalTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

export function ResultView({ scenario, result }: { scenario: Scenario; result: RebalanceResult }) {
  const lookups = buildLookups(scenario);
  return (
    <div className="result-view">
      {result.warnings.length > 0 && (
        <div className="warnings" role="alert">
          <h2>Warnings</h2>
          <ul>
            {result.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <TradesSection result={result} lookups={lookups} />
      <AllocationSection result={result} lookups={lookups} />
      <AccountsSection result={result} lookups={lookups} />
    </div>
  );
}
