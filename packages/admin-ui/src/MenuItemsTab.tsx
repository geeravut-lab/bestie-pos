import { useState } from 'react';
import {
  CHANNELS,
  channelPricesToColumn,
  formatTHB,
  itemProblems,
  localizedName,
  parsePriceInput,
  priceInputValue,
  toLocalizedText,
} from '@bestie/core';
import type { Channel, ChannelPrices } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { deleteRow, nextSort, saveRow } from './menuData';
import type { Cat, Item, Menu } from './menuData';
import { ConfirmDelete, NameFields, NameForm } from './MenuParts';

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;
export const channelLabel = (t: Dict, c: Channel): string =>
  tx(t, `channel_${c.replace('-', '_')}`);

type Props = {
  ctx: PageContext;
  storeId: string;
  menu: Menu;
  canEdit: boolean;
  onChanged: () => void;
};

export function MenuItemsTab({ ctx, storeId, menu, canEdit, onChanged }: Props) {
  const { t, lang } = useI18n();
  const locale = lang === 'th' ? 'th-TH' : 'en-GB';
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const shown = menu.items.filter((i) => filter === '' || i.category_id === filter);
  const catName = (id: string) => {
    const c = menu.cats.find((x) => x.id === id);
    return c ? localizedName(c.name, lang) : '—';
  };

  return (
    <>
      <CategoriesCard
        ctx={ctx}
        storeId={storeId}
        menu={menu}
        canEdit={canEdit}
        onChanged={onChanged}
      />
      <section className="card admin-card">
        <div className="form-row">
          <label className="label" htmlFor="menu-cat-filter">
            {t.menuItemCategory}
          </label>
          <select
            id="menu-cat-filter"
            className="field"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">{t.menuAll}</option>
            {menu.cats.map((c) => (
              <option key={c.id} value={c.id}>
                {localizedName(c.name, lang)}
              </option>
            ))}
          </select>
        </div>
        {shown.length === 0 ? <p className="muted">{t.menuEmptyItems}</p> : null}
        <ul className="member-list">
          {shown.map((item) => (
            <li key={item.id} className="member-row">
              <div className="member-head">
                <strong>{localizedName(item.name, lang)}</strong>
                <span className="tabular">{formatTHB(item.prices.base, locale)}</span>
                <span className="muted">{catName(item.category_id)}</span>
                {item.station ? (
                  <span className="badge">{tx(t, `deviceStation_${item.station}`)}</span>
                ) : null}
                {!item.available ? <span className="badge badge-warn">{t.menuSoldOut}</span> : null}
                {canEdit ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setEditing(editing === item.id ? null : item.id)}
                  >
                    {t.menuEdit}
                  </button>
                ) : null}
              </div>
              {editing === item.id ? (
                <ItemForm
                  key={item.id}
                  ctx={ctx}
                  storeId={storeId}
                  menu={menu}
                  item={item}
                  onDone={() => {
                    setEditing(null);
                    onChanged();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit && menu.cats.length > 0 ? (
          editing === 'new' ? (
            <ItemForm
              ctx={ctx}
              storeId={storeId}
              menu={menu}
              defaultCategory={filter || menu.cats[0]!.id}
              onDone={() => {
                setEditing(null);
                onChanged();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button type="button" className="btn" onClick={() => setEditing('new')}>
              {t.menuItemAdd}
            </button>
          )
        ) : null}
        {canEdit && menu.cats.length === 0 ? <Notice kind="info">{t.menuNoCategory}</Notice> : null}
      </section>
    </>
  );
}

function CategoriesCard({ ctx, storeId, menu, canEdit, onChanged }: Props) {
  const { t, lang } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const rename = (c: Cat) => async (name: Cat['name']) => {
    const err = await saveRow(ctx.client, 'menu_categories', c.id, { name });
    if (!err) {
      setEditing(null);
      onChanged();
    }
    return err;
  };
  const remove = async (c: Cat) => {
    setError(null);
    if (menu.items.some((i) => i.category_id === c.id)) {
      setConfirm(null);
      return setBlocked(c.id);
    }
    const err = await deleteRow(ctx.client, 'menu_categories', c.id);
    if (err) return setError(err);
    setConfirm(null);
    onChanged();
  };

  return (
    <section className="card admin-card">
      <h2>{t.menuCategories}</h2>
      <ul className="member-list">
        {menu.cats.map((c) => (
          <li key={c.id} className="member-row">
            <div className="member-head">
              <strong>{localizedName(c.name, lang)}</strong>
              {canEdit ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setEditing(editing === c.id ? null : c.id)}
                  >
                    {t.menuEdit}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setBlocked(null);
                      setConfirm(c.id);
                    }}
                  >
                    {t.menuDelete}
                  </button>
                </>
              ) : null}
            </div>
            {editing === c.id ? (
              <NameForm
                idPrefix={`cat-${c.id}`}
                initial={c.name}
                submitLabel={t.menuSave}
                onSave={rename(c)}
                onCancel={() => setEditing(null)}
              />
            ) : null}
            {blocked === c.id ? <Notice kind="error">{t.menuCategoryBlocked}</Notice> : null}
            {confirm === c.id ? (
              <ConfirmDelete
                label={fmt(t.menuDeleteConfirm, { name: localizedName(c.name, lang) })}
                onConfirm={() => remove(c)}
                onCancel={() => setConfirm(null)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {canEdit ? (
        <NameForm
          idPrefix="cat-new"
          submitLabel={t.menuCategoryAdd}
          clearOnSave
          onSave={async (name) => {
            const err = await saveRow(ctx.client, 'menu_categories', null, {
              org_id: ctx.orgId,
              store_id: storeId,
              name,
              sort: nextSort(menu.cats),
            });
            if (!err) onChanged();
            return err;
          }}
        />
      ) : null}
    </section>
  );
}

function ItemForm({
  ctx,
  storeId,
  menu,
  item,
  defaultCategory,
  onDone,
  onCancel,
}: {
  ctx: PageContext;
  storeId: string;
  menu: Menu;
  item?: Item;
  defaultCategory?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t, lang } = useI18n();
  const id = item?.id ?? 'new';
  const [th, setTh] = useState(item?.name.th ?? '');
  const [en, setEn] = useState(item?.name.en ?? '');
  const [categoryId, setCategoryId] = useState(item?.category_id ?? defaultCategory ?? '');
  const [base, setBase] = useState(item ? priceInputValue(item.prices.base) : '');
  const [chan, setChan] = useState<Record<string, string>>(
    Object.fromEntries(
      CHANNELS.map((c) => [
        c,
        item?.prices[c] !== undefined ? priceInputValue(item.prices[c]!) : '',
      ]),
    ),
  );
  const [station, setStation] = useState<string>(item?.station ?? '');
  const [groupIds, setGroupIds] = useState<string[]>(item?.modifier_group_ids ?? []);
  const [available, setAvailable] = useState(item?.available ?? true);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const touch = () => setSaved(false);

  const save = async () => {
    setError(null);
    setSaved(false);
    const baseSatang = parsePriceInput(base);
    const overrides: Partial<Record<Channel, number>> = {};
    for (const c of CHANNELS) {
      if (chan[c]!.trim() === '') continue;
      const v = parsePriceInput(chan[c]!);
      if (v === null) return setError('err_menu_invalid');
      overrides[c] = v;
    }
    const name = toLocalizedText(th, en);
    if (itemProblems({ name, base: baseSatang, categoryId, station: station || null }).length > 0)
      return setError('err_menu_invalid');
    const prices: ChannelPrices = channelPricesToColumn({ base: baseSatang!, ...overrides });
    const values = {
      name,
      prices,
      category_id: categoryId,
      station: station || null,
      modifier_group_ids: groupIds,
      available,
    };
    const err = item
      ? await saveRow(ctx.client, 'menu_items', item.id, values)
      : await saveRow(ctx.client, 'menu_items', null, {
          ...values,
          org_id: ctx.orgId,
          store_id: storeId,
          sort: nextSort(menu.items),
        });
    if (err) return setError(err);
    setSaved(true);
    onDone();
  };

  const remove = async () => {
    if (!item) return;
    const err = await deleteRow(ctx.client, 'menu_items', item.id);
    if (err) {
      setConfirm(false);
      return setError(err);
    }
    onDone();
  };

  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <div
        className="filters"
        onChange={touch}
        role="group"
        aria-label={item ? localizedName(item.name, lang) : t.menuItemAdd}
      >
        <NameFields idPrefix={`item-${id}`} th={th} en={en} onTh={setTh} onEn={setEn} />
        <div className="form-row">
          <label className="label" htmlFor={`item-${id}-cat`}>
            {t.menuItemCategory}
          </label>
          <select
            id={`item-${id}-cat`}
            className="field"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {menu.cats.map((c) => (
              <option key={c.id} value={c.id}>
                {localizedName(c.name, lang)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="label" htmlFor={`item-${id}-price`}>
            {t.menuItemPrice}
          </label>
          <input
            id={`item-${id}-price`}
            className="field tabular"
            inputMode="decimal"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor={`item-${id}-station`}>
            {t.menuItemStation}
          </label>
          <select
            id={`item-${id}-station`}
            className="field"
            value={station}
            onChange={(e) => setStation(e.target.value)}
          >
            <option value="">{t.menuStationNone}</option>
            <option value="kitchen">{t.deviceStation_kitchen}</option>
            <option value="bar">{t.deviceStation_bar}</option>
          </select>
        </div>
      </div>

      <fieldset className="audit-group">
        <legend>{t.menuChannelPrices}</legend>
        <div className="filters">
          {CHANNELS.map((c) => (
            <div key={c} className="form-row">
              <label className="label" htmlFor={`item-${id}-ch-${c}`}>
                {channelLabel(t, c)}
              </label>
              <input
                id={`item-${id}-ch-${c}`}
                className="field tabular"
                inputMode="decimal"
                value={chan[c]}
                onChange={(e) => {
                  setChan({ ...chan, [c]: e.target.value });
                  touch();
                }}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="audit-group">
        <legend>{t.menuItemGroups}</legend>
        {menu.groups.length === 0 ? <p className="muted">{t.menuItemGroupsNone}</p> : null}
        {menu.groups.map((g) => (
          <label key={g.id} className="check-row">
            <input
              type="checkbox"
              checked={groupIds.includes(g.id)}
              onChange={(e) => {
                setGroupIds(
                  e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id),
                );
                touch();
              }}
            />
            <span>{localizedName(g.name, lang)}</span>
          </label>
        ))}
      </fieldset>

      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          checked={available}
          onChange={(e) => {
            setAvailable(e.target.checked);
            touch();
          }}
        />
        <span className="switch-text">{t.menuItemAvailable}</span>
      </label>

      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.menuSaved}</Notice> : null}
      <div className="actions">
        <AsyncButton type="submit" onClick={save}>
          {t.menuSave}
        </AsyncButton>
        {item ? (
          <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>
            {t.menuDelete}
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t.menuCancel}
        </button>
      </div>
      {confirm && item ? (
        <ConfirmDelete
          label={fmt(t.menuDeleteConfirm, { name: localizedName(item.name, lang) })}
          onConfirm={remove}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </form>
  );
}
