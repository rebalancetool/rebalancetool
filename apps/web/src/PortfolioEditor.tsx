import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TOTAL_BPS } from "@rebalancer/solver";
import type { Scenario, TaxPreference, TaxType } from "@rebalancer/solver";
import { useState } from "react";
import { formatBpsAsPercent } from "./format.ts";
import { MoneyInput, PercentInput } from "./inputs.tsx";
import {
  addAccount,
  addAssetClass,
  addFund,
  removeAccount,
  removeAssetClass,
  removeFund,
  reorderFundPreference,
  setFundAvailability,
  targetWeightTotal,
  updateAccount,
  updateAssetClass,
  updateFund,
  withContribution,
  withHolding,
  withTargetWeight,
} from "./scenario-edit.ts";

/**
 * Builds the Portfolio half of the Scenario: asset classes, funds, and
 * accounts (tax type, buyable-fund menu with preference order, current
 * holdings). Pure structure editing — all placement decisions stay in the
 * solver.
 */

const TAX_TYPE_OPTIONS: { value: TaxType; label: string }[] = [
  { value: "taxable", label: "Taxable" },
  { value: "tax_deferred", label: "Tax-deferred" },
  { value: "tax_free", label: "Tax-free" },
];

const TAX_PREFERENCE_OPTIONS: { value: TaxPreference; label: string }[] = [
  { value: "neutral", label: "Neutral" },
  { value: "prefer_taxable", label: "Prefer taxable" },
  { value: "prefer_tax_advantaged", label: "Prefer tax-advantaged" },
];

interface EditorProps {
  scenario: Scenario;
  onChange: (scenario: Scenario) => void;
}

/** Text field + Add button (button click only — no form submit). */
function AddRow({
  placeholder,
  buttonLabel,
  onAdd,
  disabledReason,
  children,
}: {
  placeholder: string;
  buttonLabel: string;
  onAdd: (name: string) => void;
  disabledReason?: string;
  children?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const add = () => {
    if (name.trim() === "") return;
    onAdd(name.trim());
    setName("");
  };
  return (
    <div className="add-row">
      <input
        type="text"
        placeholder={placeholder}
        aria-label={placeholder}
        value={name}
        disabled={disabledReason !== undefined}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
      {children}
      <button type="button" onClick={add} disabled={disabledReason !== undefined || name.trim() === ""}>
        {buttonLabel}
      </button>
      {disabledReason && <span className="editor-hint">{disabledReason}</span>}
    </div>
  );
}

function AssetClassesCard({ scenario, onChange }: EditorProps) {
  const total = targetWeightTotal(scenario);
  const weightByClassId = new Map(scenario.targets.map((t) => [t.assetClassId, t.weight]));
  return (
    <div className="card editor-card">
      <h3>Asset classes</h3>
      <p className="editor-hint">
        The categories you allocate across, each with its target share of the whole portfolio.
      </p>
      <div className="class-row class-row-header" aria-hidden="true">
        <span>Name</span>
        <span>Tax location</span>
        <span className="class-target-heading">Target</span>
        <span />
      </div>
      {scenario.portfolio.assetClasses.map((assetClass) => (
        <div className="class-row" key={assetClass.id}>
          <input
            type="text"
            aria-label={`Asset class name (${assetClass.id})`}
            value={assetClass.name}
            onChange={(event) => onChange(updateAssetClass(scenario, assetClass.id, { name: event.target.value }))}
          />
          <select
            aria-label={`Tax preference for ${assetClass.name}`}
            value={assetClass.taxPreference ?? "neutral"}
            onChange={(event) =>
              onChange(
                updateAssetClass(scenario, assetClass.id, { taxPreference: event.target.value as TaxPreference }),
              )
            }
          >
            {TAX_PREFERENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <PercentInput
            bps={weightByClassId.get(assetClass.id) ?? 0}
            onBps={(weight) => onChange(withTargetWeight(scenario, assetClass.id, weight))}
            label={`Target weight for ${assetClass.name}`}
          />
          <button
            type="button"
            className="remove-button"
            aria-label={`Remove asset class ${assetClass.name}`}
            title="Removes this class, its funds, and their holdings"
            onClick={() => onChange(removeAssetClass(scenario, assetClass.id))}
          >
            ✕
          </button>
        </div>
      ))}
      {scenario.portfolio.assetClasses.length > 0 && (
        <div className={`class-row class-row-total ${total === TOTAL_BPS ? "total-ok" : "total-bad"}`}>
          <span className="field-label">Targets total</span>
          <span className="num class-total-value">
            {formatBpsAsPercent(total)}
            {total !== TOTAL_BPS && " — must total 100%"}
          </span>
          <span />
        </div>
      )}
      <AddRow
        placeholder="New asset class name"
        buttonLabel="Add class"
        onAdd={(name) => onChange(addAssetClass(scenario, name))}
      />
    </div>
  );
}

function FundsCard({ scenario, onChange }: EditorProps) {
  const { assetClasses, funds } = scenario.portfolio;
  const [newFundClassId, setNewFundClassId] = useState("");
  const effectiveNewClassId = assetClasses.some((c) => c.id === newFundClassId)
    ? newFundClassId
    : (assetClasses[0]?.id ?? "");
  return (
    <div className="card editor-card">
      <h3>Funds</h3>
      <p className="editor-hint">Everything you hold or could buy, tagged with its asset class.</p>
      {funds.map((fund) => (
        <div className="field-row" key={fund.id}>
          <input
            type="text"
            className="ticker-input"
            aria-label={`Ticker for fund ${fund.id}`}
            placeholder="Ticker"
            value={fund.ticker ?? ""}
            onChange={(event) => onChange(updateFund(scenario, fund.id, { ticker: event.target.value }))}
          />
          <input
            type="text"
            aria-label={`Name for fund ${fund.id}`}
            placeholder="Full name (optional)"
            value={fund.name}
            onChange={(event) => onChange(updateFund(scenario, fund.id, { name: event.target.value }))}
          />
          <select
            aria-label={`Asset class for fund ${fund.ticker || fund.id}`}
            value={fund.assetClassId}
            onChange={(event) => onChange(updateFund(scenario, fund.id, { assetClassId: event.target.value }))}
          >
            {assetClasses.map((assetClass) => (
              <option key={assetClass.id} value={assetClass.id}>
                {assetClass.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="remove-button"
            aria-label={`Remove fund ${fund.ticker || fund.id}`}
            title="Removes this fund and its holdings"
            onClick={() => onChange(removeFund(scenario, fund.id))}
          >
            ✕
          </button>
        </div>
      ))}
      <AddRow
        placeholder="New fund ticker"
        buttonLabel="Add fund"
        disabledReason={assetClasses.length === 0 ? "Add an asset class first." : undefined}
        onAdd={(ticker) => onChange(addFund(scenario, ticker.toUpperCase(), effectiveNewClassId))}
      >
        <select
          aria-label="Asset class for new fund"
          value={effectiveNewClassId}
          disabled={assetClasses.length === 0}
          onChange={(event) => setNewFundClassId(event.target.value)}
        >
          {assetClasses.map((assetClass) => (
            <option key={assetClass.id} value={assetClass.id}>
              {assetClass.name}
            </option>
          ))}
        </select>
      </AddRow>
    </div>
  );
}

function AccountCard({ scenario, onChange, accountId }: EditorProps & { accountId: string }) {
  // Whether the (zero-amount) contribution row is shown even though the
  // scenario has no entry for it — set by the add picker, cleared by its ✕.
  const [contributionOpen, setContributionOpen] = useState(false);
  const account = scenario.portfolio.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const contribution = scenario.contributions.find((c) => c.accountId === account.id)?.amount ?? 0;
  const showContribution = contributionOpen || contribution !== 0;
  return (
    <div className="card editor-card account-card">
      <div className="account-card-header">
        <input
          type="text"
          aria-label={`Account name (${account.id})`}
          value={account.name}
          onChange={(event) => onChange(updateAccount(scenario, account.id, { name: event.target.value }))}
        />
        <select
          aria-label={`Tax type for ${account.name}`}
          value={account.taxType}
          onChange={(event) => onChange(updateAccount(scenario, account.id, { taxType: event.target.value as TaxType }))}
        >
          {TAX_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="remove-button"
          aria-label={`Remove account ${account.name}`}
          title="Removes this account, its holdings, and its contribution"
          onClick={() => onChange(removeAccount(scenario, account.id))}
        >
          ✕
        </button>
      </div>
      <AccountFundList
        scenario={scenario}
        onChange={onChange}
        accountId={accountId}
        onAddContribution={showContribution ? undefined : () => setContributionOpen(true)}
      />
      {showContribution && (
        // Focusing the input pins the row open, so clearing the amount while
        // editing doesn't unmount the field mid-keystroke.
        <div className="contribution-row" onFocusCapture={() => setContributionOpen(true)}>
          <span className="field-label">
            Cash to invest
            <span className="editor-hint">New contribution earmarked to this account</span>
          </span>
          <span className="fund-value-cell">
            <MoneyInput
              cents={contribution}
              onCents={(amount) => onChange(withContribution(scenario, account.id, amount))}
              label={`Cash to invest in ${account.name}`}
            />
          </span>
          <button
            type="button"
            className="remove-button"
            aria-label={`Remove cash to invest from ${account.name}`}
            title="Clears this account's contribution"
            onClick={() => {
              setContributionOpen(false);
              onChange(withContribution(scenario, account.id, 0));
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** Sentinel picker value for adding a contribution row — fund ids are slugs, so this can't collide. */
const ADD_CASH = "__cash__";

/**
 * The funds actually in an account: its buyable menu in preference order,
 * then anything held-but-no-longer-buyable. New funds join via the picker
 * at the bottom (fed from the Funds card), which also offers a "cash to
 * invest" row when `onAddContribution` is provided; ✕ takes the fund out
 * of the account entirely (menu and holding).
 */
function AccountFundList({
  scenario,
  onChange,
  accountId,
  onAddContribution,
}: EditorProps & { accountId: string; onAddContribution?: () => void }) {
  const account = scenario.portfolio.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const { funds, holdings } = scenario.portfolio;
  const fundsById = new Map(funds.map((f) => [f.id, f]));
  const fundLabel = (fundId: string) => {
    const fund = fundsById.get(fundId);
    return fund?.ticker || fund?.name || fundId;
  };
  const holdingByFundId = new Map(
    holdings.filter((h) => h.accountId === accountId).map((h) => [h.fundId, h.value]),
  );

  const heldOnlyFundIds = funds
    .filter((f) => !account.availableFundIds.includes(f.id) && holdingByFundId.has(f.id))
    .map((f) => f.id);
  const inAccount = new Set([...account.availableFundIds, ...heldOnlyFundIds]);
  const addable = funds.filter((f) => !inAccount.has(f.id));

  const removeFromAccount = (fundId: string) =>
    onChange(withHolding(setFundAvailability(scenario, account.id, fundId, false), account.id, fundId, 0));

  const sensors = useSensors(
    // A few px of slop so a plain click on the handle doesn't start a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = account.availableFundIds.indexOf(String(over.id));
    if (toIndex === -1) return;
    onChange(reorderFundPreference(scenario, account.id, String(active.id), toIndex));
  };

  const rowFor = (fundId: string) => ({
    valueCents: holdingByFundId.get(fundId) ?? 0,
    onValue: (value: number) => onChange(withHolding(scenario, account.id, fundId, value)),
    onRemove: () => removeFromAccount(fundId),
  });

  return (
    <>
      {funds.length === 0 ? (
        <p className="editor-hint">Add funds to give this account something to hold or buy.</p>
      ) : account.availableFundIds.length === 0 && heldOnlyFundIds.length === 0 ? (
        <p className="editor-hint">No funds in this account yet — add one below.</p>
      ) : (
        <div className="fund-list">
          <div className="fund-row fund-list-header" aria-hidden="true">
            <span />
            <span>Fund</span>
            <span className="fund-value-heading">Current value</span>
            <span />
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={account.availableFundIds} strategy={verticalListSortingStrategy}>
              <ul className="fund-rows">
                {account.availableFundIds.map((fundId, index) => (
                  <SortableFundRow
                    key={fundId}
                    fundId={fundId}
                    label={fundLabel(fundId)}
                    accountName={account.name}
                    rank={index + 1}
                    {...rowFor(fundId)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {heldOnlyFundIds.length > 0 && (
            <ul className="fund-rows">
              {heldOnlyFundIds.map((fundId) => (
                <li className="fund-row" key={fundId}>
                  <span className="drag-cell">
                    <span className="chip">held</span>
                  </span>
                  <span className="fund-row-label" title="Held but not buyable in this account">
                    {fundLabel(fundId)} <span className="editor-hint-inline">not buyable</span>
                  </span>
                  <span className="fund-value-cell">
                    <MoneyInput
                      cents={rowFor(fundId).valueCents}
                      onCents={rowFor(fundId).onValue}
                      label={`Current value of ${fundLabel(fundId)} in ${account.name}`}
                    />
                  </span>
                  <RemoveFundButton label={fundLabel(fundId)} accountName={account.name} onRemove={rowFor(fundId).onRemove} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(addable.length > 0 || onAddContribution) && (
        <div className="add-fund-row">
          <select
            aria-label={`Add to ${account.name}`}
            value=""
            onChange={(event) => {
              if (event.target.value === ADD_CASH) onAddContribution?.();
              else if (event.target.value) {
                onChange(setFundAvailability(scenario, account.id, event.target.value, true));
              }
            }}
          >
            <option value="">
              {addable.length === 0 ? "＋ Add cash…" : onAddContribution ? "＋ Add fund or cash…" : "＋ Add fund…"}
            </option>
            {addable.map((fund) => (
              <option key={fund.id} value={fund.id}>
                {fund.ticker || fund.name || fund.id}
                {fund.name && fund.ticker ? ` — ${fund.name}` : ""}
              </option>
            ))}
            {onAddContribution && <option value={ADD_CASH}>Cash to invest (new contribution)</option>}
          </select>
        </div>
      )}
    </>
  );
}

function RemoveFundButton({
  label,
  accountName,
  onRemove,
}: {
  label: string;
  accountName: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="remove-button"
      aria-label={`Remove ${label} from ${accountName}`}
      title="Removes this fund from the account (menu and holding)"
      onClick={onRemove}
    >
      ✕
    </button>
  );
}

/**
 * One draggable row of an account's buyable menu. The grip is the only drag
 * activator, so the money input and buttons stay ordinary controls; it is a
 * real button, so keyboard users can focus it and reorder with
 * space + arrow keys (dnd-kit's keyboard sensor).
 */
function SortableFundRow({
  fundId,
  label,
  accountName,
  rank,
  valueCents,
  onValue,
  onRemove,
}: {
  fundId: string;
  label: string;
  accountName: string;
  rank: number;
  valueCents: number;
  onValue: (value: number) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: fundId,
  });
  return (
    <li
      ref={setNodeRef}
      className={`fund-row${isDragging ? " fund-row-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="drag-cell">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="drag-handle"
          aria-label={`Reorder ${label} in ${accountName} (position ${rank})`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="num rank">#{rank}</span>
      </span>
      <span className="fund-row-label">{label}</span>
      <span className="fund-value-cell">
        <MoneyInput cents={valueCents} onCents={onValue} label={`Current value of ${label} in ${accountName}`} />
      </span>
      <RemoveFundButton label={label} accountName={accountName} onRemove={onRemove} />
    </li>
  );
}

export function PortfolioEditor({ scenario, onChange }: EditorProps) {
  const [newAccountTaxType, setNewAccountTaxType] = useState<TaxType>("taxable");
  return (
    <section aria-labelledby="portfolio-heading">
      <h2 id="portfolio-heading">Portfolio</h2>
      <div className="editor-grid">
        <AssetClassesCard scenario={scenario} onChange={onChange} />
        <FundsCard scenario={scenario} onChange={onChange} />
      </div>
      <h2>Accounts &amp; holdings</h2>
      {scenario.portfolio.accounts.map((account) => (
        <AccountCard key={account.id} scenario={scenario} onChange={onChange} accountId={account.id} />
      ))}
      <div className="card editor-card">
        <AddRow
          placeholder="New account name"
          buttonLabel="Add account"
          onAdd={(name) => onChange(addAccount(scenario, name, newAccountTaxType))}
        >
          <select
            aria-label="Tax type for new account"
            value={newAccountTaxType}
            onChange={(event) => setNewAccountTaxType(event.target.value as TaxType)}
          >
            {TAX_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </AddRow>
      </div>
    </section>
  );
}
