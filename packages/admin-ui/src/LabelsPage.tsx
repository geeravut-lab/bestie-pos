import { useMemo, useState } from 'react';
import {
  LABEL_SIZES,
  MAX_LABELS,
  formatTHB,
  labelCount,
  labelSize,
  localizedName,
  planLabels,
  printableCode,
  sheetCount,
} from '@bestie/core';
import type { LabelItem, LabelPlan, LabelSize } from '@bestie/core';
import { fmt, useI18n } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { BarcodeSvg } from './BarcodeSvg';
import { PrintPortal } from './PrintPortal';
import { loadMenu } from './menuData';
import { tx } from './stockInput';
import { useRemote } from './useRemote';

/** One label: name, price and — when the dish has a printable barcode — the bars with the code under them. */
function Label({ item, shop, lang }: { item: LabelItem; shop: string; lang: 'th' | 'en' }) {
  const { t } = useI18n();
  const code = printableCode(item.barcode);
  return (
    <div className="price-label">
      <span className="price-label-shop">{shop}</span>
      <span className="price-label-name">{localizedName(item.name, lang)}</span>
      <span className="price-label-price tabular">
        {formatTHB(item.price, lang === 'th' ? 'th-TH' : 'en-GB')}
      </span>
      {code ? (
        <>
          <BarcodeSvg code={code} label={fmt(t.labelsBarcodeAlt, { code })} />
          <span className="price-label-code tabular">{code}</span>
        </>
      ) : item.sku ? (
        <span className="price-label-code tabular">{item.sku}</span>
      ) : null}
    </div>
  );
}

function Sheet({
  plan,
  size,
  shop,
  lang,
  limit,
}: {
  plan: LabelPlan[];
  size: LabelSize;
  shop: string;
  lang: 'th' | 'en';
  limit?: number;
}) {
  const labels = plan.flatMap((p) =>
    Array.from({ length: p.copies }, (_, i) => ({ item: p.item, key: `${p.item.id}-${i}` })),
  );
  return (
    <div
      className="label-grid"
      style={
        {
          '--label-w': `${size.widthMm}mm`,
          '--label-h': `${size.heightMm}mm`,
          '--label-cols': size.columns,
        } as React.CSSProperties
      }
    >
      {(limit ? labels.slice(0, limit) : labels).map((l) => (
        <Label key={l.key} item={l.item} shop={shop} lang={lang} />
      ))}
    </div>
  );
}

/** Price labels with a barcode, for the shelf: pick items and copies, pick the paper, print (or save as PDF). */
export function LabelsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const storeId = ctx.storeId ?? ctx.homeStoreId ?? null;
  const canEdit = ctx.isOwner || ctx.permissions.includes('menu.edit');
  const [sizeId, setSizeId] = useState(LABEL_SIZES[0]!.id);
  const [copies, setCopies] = useState<Record<string, number>>({});
  const data = useRemote(async () => {
    if (!storeId) throw new Error('shop');
    const [menu, store] = await Promise.all([
      loadMenu(ctx.client, storeId),
      ctx.client.from('stores').select('name').eq('id', storeId).maybeSingle(),
    ]);
    return { menu, shop: String((store.data as { name?: string } | null)?.name ?? '') };
  }, storeId ?? '');

  const items: LabelItem[] = useMemo(
    () =>
      (data.data?.menu.items ?? []).map((i) => ({
        id: i.id,
        name: i.name,
        price: i.prices.base,
        barcode: i.barcode ?? null,
        sku: i.sku ?? null,
      })),
    [data.data],
  );
  const size = labelSize(sizeId);
  const plan = planLabels(items, copies);
  const total = labelCount(plan);

  if (!canEdit)
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_forbidden}</Notice>
      </div>
    );
  const setAll = (pick: (i: LabelItem) => boolean) =>
    setCopies(Object.fromEntries(items.filter(pick).map((i) => [i.id, 1])));
  const shop = data.data?.shop ?? '';

  return (
    <div className="admin-page">
      <h1>{t.labelsTitle}</h1>
      <Notice kind="info">{t.labelsIntro}</Notice>
      {data.status === 'loading' ? (
        <p className="sso-working" role="status">
          <Spinner /> {t.loading}
        </p>
      ) : null}
      {data.status === 'error' ? <Notice kind="error">{t.err_load_failed}</Notice> : null}
      {data.data ? (
        <>
          <section className="card admin-card">
            <div className="form-row">
              <label className="label" htmlFor="label-size">
                {t.labelsSize}
              </label>
              <select
                id="label-size"
                className="field"
                value={sizeId}
                onChange={(e) => setSizeId(e.target.value)}
              >
                {LABEL_SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {tx(t, `labelSize_${s.id}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setAll(() => true)}
              >
                {t.labelsAll}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setAll((i) => !!printableCode(i.barcode))}
              >
                {t.labelsWithCode}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setCopies({})}>
                {t.labelsClear}
              </button>
            </div>
            <ul className="member-list">
              {items.map((i) => (
                <li key={i.id} className="member-row">
                  <div className="member-head">
                    <label htmlFor={`lab-${i.id}`}>
                      <strong>{localizedName(i.name, lang)}</strong>
                    </label>
                    <span className="tabular">
                      {formatTHB(i.price, lang === 'th' ? 'th-TH' : 'en-GB')}
                    </span>
                    <span className="muted tabular">{i.barcode ?? t.labelsNoCode}</span>
                    <input
                      id={`lab-${i.id}`}
                      className="field tabular label-copies"
                      type="number"
                      min={0}
                      max={MAX_LABELS}
                      inputMode="numeric"
                      aria-label={fmt(t.labelsCopiesOf, { name: localizedName(i.name, lang) })}
                      value={copies[i.id] ?? 0}
                      onChange={(e) =>
                        setCopies({
                          ...copies,
                          [i.id]: Math.max(0, Math.trunc(Number(e.target.value)) || 0),
                        })
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
            {items.length === 0 ? <p className="muted">{t.menuEmptyItems}</p> : null}
          </section>
          <section className="card admin-card" aria-label={t.labelsPreview}>
            <h2>{t.labelsPreview}</h2>
            {total === 0 ? (
              <p className="muted">{t.labelsNone}</p>
            ) : (
              <>
                <Sheet
                  plan={plan}
                  size={size}
                  shop={shop}
                  lang={lang === 'th' ? 'th' : 'en'}
                  limit={6}
                />
                <p className="muted">
                  {fmt(t.labelsCount, { n: total, sheets: sheetCount(total, size) })}
                </p>
              </>
            )}
            <div className="actions">
              <AsyncButton disabled={total === 0} onClick={() => window.print()}>
                {fmt(t.labelsPrint, { n: total })}
              </AsyncButton>
            </div>
          </section>
          {total > 0 ? (
            <PrintPortal
              pageCss={
                size.sheet === 'roll'
                  ? `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`
                  : '@page { size: A4; margin: 8mm; }'
              }
            >
              <Sheet plan={plan} size={size} shop={shop} lang={lang === 'th' ? 'th' : 'en'} />
            </PrintPortal>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
