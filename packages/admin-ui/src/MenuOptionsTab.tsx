import { useState } from 'react';
import {
  CHANNELS,
  formatTHB,
  groupProblems,
  localizedName,
  nameProblems,
  parseDeltaInput,
  priceInputValue,
  toLocalizedText,
} from '@bestie/core';
import type { Channel } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { deleteRow, nextSort, saveRow } from './menuData';
import type { Group, Menu, Opt } from './menuData';
import { channelLabel } from './MenuItemsTab';
import { ConfirmDelete, NameFields } from './MenuParts';

type Props = {
  ctx: PageContext;
  storeId: string;
  menu: Menu;
  canEdit: boolean;
  onChanged: () => void;
};

export function MenuOptionsTab({ ctx, storeId, menu, canEdit, onChanged }: Props) {
  const { t, lang } = useI18n();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [inUse, setInUse] = useState<{ id: string; n: number } | null>(null);

  const askDelete = (g: Group) => {
    setError(null);
    const n = menu.items.filter((i) => i.modifier_group_ids.includes(g.id)).length;
    if (n > 0) {
      setConfirm(null);
      return setInUse({ id: g.id, n });
    }
    setInUse(null);
    setConfirm(g.id);
  };
  const remove = async (g: Group) => {
    const err = await deleteRow(ctx.client, 'modifier_groups', g.id);
    if (err) {
      setConfirm(null);
      return setError(err);
    }
    setConfirm(null);
    onChanged();
  };

  return (
    <section className="card admin-card">
      <h2>{t.groupsTitle}</h2>
      <p className="muted">{t.groupsIntro}</p>
      <ul className="member-list">
        {menu.groups.map((g) => {
          const opts = menu.opts.filter((o) => o.group_id === g.id);
          const lacking = g.min_select > opts.length;
          return (
            <li key={g.id} className="member-row">
              <div className="member-head">
                <strong>{localizedName(g.name, lang)}</strong>
                <span className="badge">
                  {fmt(t.groupRule, { min: g.min_select, max: g.max_select })}
                </span>
                {canEdit ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setEditing(editing === g.id ? null : g.id)}
                    >
                      {t.menuEdit}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => askDelete(g)}
                    >
                      {t.menuDelete}
                    </button>
                  </>
                ) : null}
              </div>
              {lacking ? (
                <Notice kind="error">
                  {fmt(t.groupNeedMore, { min: g.min_select, have: opts.length })}
                </Notice>
              ) : null}
              {inUse?.id === g.id ? (
                <Notice kind="error">{fmt(t.groupInUse, { n: inUse.n })}</Notice>
              ) : null}
              {confirm === g.id ? (
                <ConfirmDelete
                  label={fmt(t.menuDeleteConfirm, { name: localizedName(g.name, lang) })}
                  onConfirm={() => remove(g)}
                  onCancel={() => setConfirm(null)}
                />
              ) : null}
              {editing === g.id ? (
                <GroupForm
                  key={g.id}
                  ctx={ctx}
                  storeId={storeId}
                  menu={menu}
                  group={g}
                  optionCount={opts.length}
                  onDone={() => {
                    setEditing(null);
                    onChanged();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : null}
              <OptionList
                ctx={ctx}
                storeId={storeId}
                group={g}
                opts={opts}
                canEdit={canEdit}
                onChanged={onChanged}
              />
            </li>
          );
        })}
      </ul>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {canEdit ? (
        editing === 'new' ? (
          <GroupForm
            ctx={ctx}
            storeId={storeId}
            menu={menu}
            optionCount={0}
            onDone={() => {
              setEditing(null);
              onChanged();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            {t.groupAdd}
          </button>
        )
      ) : null}
    </section>
  );
}

function GroupForm({
  ctx,
  storeId,
  menu,
  group,
  optionCount,
  onDone,
  onCancel,
}: {
  ctx: PageContext;
  storeId: string;
  menu: Menu;
  group?: Group;
  optionCount: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const id = group?.id ?? 'new';
  const [th, setTh] = useState(group?.name.th ?? '');
  const [en, setEn] = useState(group?.name.en ?? '');
  const [min, setMin] = useState(String(group?.min_select ?? 0));
  const [max, setMax] = useState(String(group?.max_select ?? 1));
  const [error, setError] = useState<ErrorKey | null>(null);

  const save = async () => {
    setError(null);
    const name = toLocalizedText(th, en);
    const minN = /^\d{1,2}$/.test(min.trim()) ? Number(min) : NaN;
    const maxN = /^\d{1,2}$/.test(max.trim()) ? Number(max) : NaN;
    // an existing group may still be empty while the owner is setting it up; a NEW required group is allowed too,
    // the options tab then shows the warning until enough options exist
    const problems = groupProblems({
      name,
      min: minN,
      max: maxN,
      optionCount: Math.max(optionCount, minN),
    });
    if (problems.length > 0) return setError('err_menu_invalid');
    const values = { name, min_select: minN, max_select: maxN };
    const err = group
      ? await saveRow(ctx.client, 'modifier_groups', group.id, values)
      : await saveRow(ctx.client, 'modifier_groups', null, {
          ...values,
          org_id: ctx.orgId,
          store_id: storeId,
          sort: nextSort(menu.groups),
        });
    if (err) return setError(err);
    onDone();
  };

  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <div className="filters">
        <NameFields idPrefix={`grp-${id}`} th={th} en={en} onTh={setTh} onEn={setEn} />
        <div className="form-row">
          <label className="label" htmlFor={`grp-${id}-min`}>
            {t.groupMin}
          </label>
          <input
            id={`grp-${id}-min`}
            className="field tabular"
            inputMode="numeric"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor={`grp-${id}-max`}>
            {t.groupMax}
          </label>
          <input
            id={`grp-${id}-max`}
            className="field tabular"
            inputMode="numeric"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </div>
      </div>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={save}>
          {t.menuSave}
        </AsyncButton>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t.menuCancel}
        </button>
      </div>
    </form>
  );
}

function OptionList({
  ctx,
  storeId,
  group,
  opts,
  canEdit,
  onChanged,
}: {
  ctx: PageContext;
  storeId: string;
  group: Group;
  opts: Opt[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const done = () => {
    setEditing(null);
    onChanged();
  };
  return (
    <div className="option-list">
      {opts.length === 0 ? <p className="muted">{t.optionNone}</p> : null}
      <ul className="member-list">
        {opts.map((o) => (
          <li key={o.id} className="member-row">
            <div className="member-head">
              <span>{localizedName(o.name, lang)}</span>
              <span className="tabular muted">
                {o.price_delta === 0
                  ? t.optionFree
                  : `${o.price_delta > 0 ? '+' : '−'}${formatTHB(Math.abs(o.price_delta), locale)}`}
              </span>
              {canEdit ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditing(editing === o.id ? null : o.id)}
                >
                  {t.menuEdit}
                </button>
              ) : null}
            </div>
            {editing === o.id ? (
              <OptionForm
                key={o.id}
                ctx={ctx}
                storeId={storeId}
                group={group}
                opts={opts}
                option={o}
                onDone={done}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        editing === 'new' ? (
          <OptionForm
            ctx={ctx}
            storeId={storeId}
            group={group}
            opts={opts}
            onDone={done}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => setEditing('new')}>
            {t.optionAdd}
            <span className="visually-hidden"> — {localizedName(group.name, lang)}</span>
          </button>
        )
      ) : null}
    </div>
  );
}

function OptionForm({
  ctx,
  storeId,
  group,
  opts,
  option,
  onDone,
  onCancel,
}: {
  ctx: PageContext;
  storeId: string;
  group: Group;
  opts: Opt[];
  option?: Opt;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t, lang } = useI18n();
  const id = option?.id ?? `new-${group.id}`;
  const [th, setTh] = useState(option?.name.th ?? '');
  const [en, setEn] = useState(option?.name.en ?? '');
  const [delta, setDelta] = useState(option ? priceInputValue(option.price_delta) : '');
  const [chan, setChan] = useState<Record<string, string>>(
    Object.fromEntries(
      CHANNELS.map((c) => [
        c,
        option?.channel_delta[c] !== undefined ? priceInputValue(option.channel_delta[c]!) : '',
      ]),
    ),
  );
  const [error, setError] = useState<ErrorKey | null>(null);
  const [confirm, setConfirm] = useState(false);

  const save = async () => {
    setError(null);
    const name = toLocalizedText(th, en);
    const base = parseDeltaInput(delta);
    if (nameProblems(name).length > 0 || base === null) return setError('err_menu_invalid');
    const channelDelta: Partial<Record<Channel, number>> = {};
    for (const c of CHANNELS) {
      if (chan[c]!.trim() === '') continue;
      const v = parseDeltaInput(chan[c]!);
      if (v === null) return setError('err_menu_invalid');
      if (v !== base) channelDelta[c] = v; // equal to the base change = no override needed
    }
    const values = { name, price_delta: base, channel_delta: channelDelta };
    const err = option
      ? await saveRow(ctx.client, 'modifier_options', option.id, values)
      : await saveRow(ctx.client, 'modifier_options', null, {
          ...values,
          org_id: ctx.orgId,
          store_id: storeId,
          group_id: group.id,
          sort: nextSort(opts),
        });
    if (err) return setError(err);
    onDone();
  };

  const remove = async () => {
    if (!option) return;
    const err = await deleteRow(ctx.client, 'modifier_options', option.id);
    if (err) {
      setConfirm(false);
      return setError(err);
    }
    onDone();
  };

  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <div className="filters">
        <NameFields idPrefix={`opt-${id}`} th={th} en={en} onTh={setTh} onEn={setEn} />
        <div className="form-row">
          <label className="label" htmlFor={`opt-${id}-delta`}>
            {t.optionDelta}
          </label>
          <input
            id={`opt-${id}-delta`}
            className="field tabular"
            inputMode="decimal"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
          />
        </div>
      </div>
      <fieldset className="audit-group">
        <legend>{t.optionChannelDelta}</legend>
        <div className="filters">
          {CHANNELS.map((c) => (
            <div key={c} className="form-row">
              <label className="label" htmlFor={`opt-${id}-ch-${c}`}>
                {channelLabel(t, c)}
              </label>
              <input
                id={`opt-${id}-ch-${c}`}
                className="field tabular"
                inputMode="decimal"
                value={chan[c]}
                onChange={(e) => setChan({ ...chan, [c]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </fieldset>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={save}>
          {t.menuSave}
        </AsyncButton>
        {option ? (
          <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>
            {t.menuDelete}
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t.menuCancel}
        </button>
      </div>
      {confirm && option ? (
        <ConfirmDelete
          label={fmt(t.menuDeleteConfirm, { name: localizedName(option.name, lang) })}
          onConfirm={remove}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </form>
  );
}
