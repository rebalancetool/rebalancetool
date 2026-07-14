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
import type { Fund, Scenario, TaxPreference, TaxType } from "@rebalancer/solver";
import { useState } from "react";
import { formatBpsAsPercent } from "./format.ts";
import { MoneyInput, PercentInput } from "./inputs.tsx";
import {
  addAccount,
  addAssetClass,
  addFund,
  addFundClass,
  fundWeightTotal,
  removeAccount,
  removeAssetClass,
  removeFund,
  removeFundClass,
  reorderFundPreference,
  replaceFundClass,
  setFundAvailability,
  setFundClassWeight,
  setFundSoleClass,
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
  { value: "prefer_taxable", label: "Taxable" },
  { value: "prefer_tax_advantaged", label: "Tax-advantaged" },
];

interface EditorProps {
  scenario: Scenario;
  onChange: (scenario: Scenario) => void;
}

/**
 * Text field + Add button (button click only — no form submit). `draftError`
 * vets the trimmed draft as it's typed — a duplicate name, say — disabling
 * the button with the returned message instead of letting a bad add through.
 */
function AddRow({
  placeholder,
  buttonLabel,
  onAdd,
  disabledReason,
  draftError,
  children,
}: {
  placeholder: string;
  buttonLabel: string;
  onAdd: (name: string) => void;
  disabledReason?: string;
  draftError?: (name: string) => string | undefined;
  children?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const error = name.trim() === "" ? undefined : draftError?.(name.trim());
  const add = () => {
    if (name.trim() === "" || error !== undefined) return;
    onAdd(name.trim());
    setName("");
  };
  return (
    <div className="add-row">
      <input
        type="text"
        autoComplete="off"
        data-1p-ignore
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
      <button
        type="button"
        onClick={add}
        disabled={disabledReason !== undefined || name.trim() === "" || error !== undefined}
      >
        {buttonLabel}
      </button>
      {disabledReason && <span className="editor-hint">{disabledReason}</span>}
      {!disabledReason && error && <span className="editor-hint">{error}</span>}
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
            autoComplete="off"
            data-1p-ignore
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
        // A total of 0 means allocating hasn't started (fresh page, or every
        // target blank) — show the requirement quietly instead of scolding a
        // page the user hasn't touched. Red is for started-but-inconsistent;
        // once accounts exist the solver's own error enforces the rule too.
        <div
          className={`class-row class-row-total ${
            total === TOTAL_BPS ? "total-ok" : total === 0 ? "total-pending" : "total-bad"
          }`}
        >
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
        draftError={(name) =>
          scenario.portfolio.assetClasses.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())
            ? `An asset class named "${name}" already exists.`
            : undefined
        }
      />
    </div>
  );
}

/** Sentinel option in a fund's class picker for switching it to a multi-class blend. */
const BLEND = "__blend__";

/**
 * "65% US Stocks · 35% International Stocks" — a blend at a glance, largest
 * slice first.
 */
function blendSummary(fund: Fund, classNames: Map<string, string>): string {
  return Object.entries(fund.assetClasses)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([classId, weight]) => `${formatBpsAsPercent(weight)} ${classNames.get(classId) ?? classId}`)
    .join(" · ");
}

/**
 * The expanded slice-by-slice editor for one fund's blend: each slice is a
 * class picker plus its weight, with a live "must total 100%" check and an
 * add picker for the classes not yet in the blend.
 */
function BlendEditor({ scenario, onChange, fund, label }: EditorProps & { fund: Fund; label: string }) {
  const { assetClasses } = scenario.portfolio;
  const classNames = new Map(assetClasses.map((c) => [c.id, c.name]));
  const slices = Object.entries(fund.assetClasses);
  const addable = assetClasses.filter((c) => !(c.id in fund.assetClasses));
  const total = fundWeightTotal(fund);
  return (
    <div className="blend-editor">
      {slices.map(([classId, weight]) => (
        <div className="blend-row" key={classId}>
          <select
            aria-label={`Class of the ${classNames.get(classId) ?? classId} slice in ${label}`}
            value={classId}
            onChange={(event) => onChange(replaceFundClass(scenario, fund.id, classId, event.target.value))}
          >
            <option value={classId}>{classNames.get(classId) ?? classId}</option>
            {addable.map((assetClass) => (
              <option key={assetClass.id} value={assetClass.id}>
                {assetClass.name}
              </option>
            ))}
          </select>
          <PercentInput
            bps={weight}
            onBps={(w) => onChange(setFundClassWeight(scenario, fund.id, classId, w))}
            label={`Weight of ${classNames.get(classId) ?? classId} in ${label}`}
          />
          <button
            type="button"
            className="remove-button"
            aria-label={`Remove ${classNames.get(classId) ?? classId} from ${label}`}
            title="Removes this slice (a last remaining slice can't be removed)"
            disabled={slices.length === 1}
            onClick={() => onChange(removeFundClass(scenario, fund.id, classId))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="blend-row blend-row-footer">
        {addable.length > 0 ? (
          <select
            aria-label={`Add asset class to ${label}`}
            value=""
            onChange={(event) => {
              if (event.target.value) onChange(addFundClass(scenario, fund.id, event.target.value));
            }}
          >
            <option value="">＋ Add class…</option>
            {addable.map((assetClass) => (
              <option key={assetClass.id} value={assetClass.id}>
                {assetClass.name}
              </option>
            ))}
          </select>
        ) : (
          <span />
        )}
        <span className={`blend-total ${total === TOTAL_BPS ? "total-ok" : "total-bad"}`}>
          blend total <span className="num">{formatBpsAsPercent(total)}</span>
          {total !== TOTAL_BPS && " — must total 100%"}
        </span>
      </div>
    </div>
  );
}

function FundsCard({ scenario, onChange }: EditorProps) {
  const { assetClasses, funds } = scenario.portfolio;
  const [newFundClassId, setNewFundClassId] = useState("");
  // Fund ids whose blend editor is open. A single-class fund lands here by
  // picking "Blend of classes…" in its class picker; a real blend shows a
  // summary that toggles membership. Purely view state — no scenario change.
  const [openBlends, setOpenBlends] = useState<Set<string>>(new Set());
  const classNames = new Map(assetClasses.map((c) => [c.id, c.name]));
  const effectiveNewClassId =
    newFundClassId === BLEND || assetClasses.some((c) => c.id === newFundClassId)
      ? newFundClassId
      : (assetClasses[0]?.id ?? "");
  const setBlendOpen = (fundId: string, open: boolean) =>
    setOpenBlends((prev) => {
      const next = new Set(prev);
      if (open) next.add(fundId);
      else next.delete(fundId);
      return next;
    });
  return (
    <div className="card editor-card">
      <h3>Funds</h3>
      <p className="editor-hint">
        Everything you hold or could buy, tagged with its asset class — or a blend of classes (e.g. VT is 65% US /
        35% international). The starter list is an editable placeholder, not a recommendation.
      </p>
      {funds.map((fund) => {
        const label = fund.ticker || fund.name || fund.id;
        const slices = Object.entries(fund.assetClasses);
        const isBlend = slices.length > 1;
        const expanded = openBlends.has(fund.id);
        return (
          <div className="fund-block" key={fund.id}>
            <div className="field-row">
              <input
                type="text"
                autoComplete="off"
                data-1p-ignore
                className="ticker-input"
                aria-label={`Ticker for fund ${fund.id}`}
                placeholder="Ticker"
                value={fund.ticker ?? ""}
                onChange={(event) => onChange(updateFund(scenario, fund.id, { ticker: event.target.value }))}
              />
              <input
                type="text"
                autoComplete="off"
                data-1p-ignore
                aria-label={`Name for fund ${fund.id}`}
                placeholder="Full name (optional)"
                value={fund.name}
                onChange={(event) => onChange(updateFund(scenario, fund.id, { name: event.target.value }))}
              />
              {isBlend || expanded ? (
                <button
                  type="button"
                  className="blend-summary"
                  aria-label={`Asset class blend for ${label}`}
                  aria-expanded={expanded}
                  title={blendSummary(fund, classNames)}
                  onClick={() => setBlendOpen(fund.id, !expanded)}
                >
                  Blend
                  <svg className="blend-caret" viewBox="0 0 10 6" aria-hidden="true">
                    <path
                      d="M1 1l4 4 4-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : (
                <select
                  aria-label={`Asset class for fund ${label}`}
                  value={slices[0]?.[0] ?? ""}
                  onChange={(event) => {
                    if (event.target.value === BLEND) setBlendOpen(fund.id, true);
                    else onChange(setFundSoleClass(scenario, fund.id, event.target.value));
                  }}
                >
                  {assetClasses.map((assetClass) => (
                    <option key={assetClass.id} value={assetClass.id}>
                      {assetClass.name}
                    </option>
                  ))}
                  <option value={BLEND}>Blend of classes…</option>
                </select>
              )}
              <button
                type="button"
                className="remove-button"
                aria-label={`Remove fund ${label}`}
                title="Removes this fund and its holdings"
                onClick={() => onChange(removeFund(scenario, fund.id))}
              >
                ✕
              </button>
            </div>
            {expanded && <BlendEditor scenario={scenario} onChange={onChange} fund={fund} label={label} />}
          </div>
        );
      })}
      <AddRow
        placeholder="New fund ticker"
        buttonLabel="Add fund"
        disabledReason={assetClasses.length === 0 ? "Add an asset class first." : undefined}
        draftError={(ticker) =>
          funds.some((f) => (f.ticker ?? "").trim().toUpperCase() === ticker.toUpperCase())
            ? `${ticker.toUpperCase()} is already in the fund list.`
            : undefined
        }
        onAdd={(ticker) => {
          // A brand-new blend starts as 100% of the first class with its
          // slice editor open, ready to be carved up.
          const isBlend = effectiveNewClassId === BLEND;
          const next = addFund(scenario, ticker.toUpperCase(), isBlend ? assetClasses[0]!.id : effectiveNewClassId);
          if (isBlend) setBlendOpen(next.portfolio.funds[next.portfolio.funds.length - 1]!.id, true);
          onChange(next);
        }}
      >
        <select
          aria-label="Asset class for new fund"
          value={effectiveNewClassId}
          disabled={assetClasses.length === 0}
          onChange={(event) => setNewFundClassId(event.target.value)}
        >
          {/* Before any class exists the (disabled) picker shows blank, not "Blend…". */}
          {assetClasses.length === 0 && <option value="" />}
          {assetClasses.map((assetClass) => (
            <option key={assetClass.id} value={assetClass.id}>
              {assetClass.name}
            </option>
          ))}
          {assetClasses.length > 0 && <option value={BLEND}>Blend of classes…</option>}
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
          autoComplete="off"
          data-1p-ignore
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
      <p className="editor-hint section-hint">
        Each account lists just the funds it can trade, in your order of preference — #1 is bought first.
      </p>
      {scenario.portfolio.accounts.map((account) => (
        <AccountCard key={account.id} scenario={scenario} onChange={onChange} accountId={account.id} />
      ))}
      <div className="card editor-card">
        {scenario.portfolio.accounts.length === 0 && (
          <p className="editor-hint">
            Add each account you hold — 401(k), IRA, brokerage — with its tax type; funds and balances come next.
          </p>
        )}
        <AddRow
          placeholder="New account name"
          buttonLabel="Add account"
          onAdd={(name) => onChange(addAccount(scenario, name, newAccountTaxType))}
          draftError={(name) =>
            scenario.portfolio.accounts.some((a) => a.name.trim().toLowerCase() === name.toLowerCase())
              ? `An account named "${name}" already exists.`
              : undefined
          }
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
