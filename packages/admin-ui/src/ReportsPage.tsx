import { useState } from 'react';
import {
  formatTHB,
  parseReturnsReport,
  parseSalesReport,
  presetRange,
  reportCsv,
} from '@bestie/core';
import type { RangePreset, ReportSection, SalesReport } from '@bestie/core';
import { errorText, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type Tab = 'summary' | 'items' | 'hours' | 'payments' | 'staff';
const TABS: readonly Tab[] = ['summary', 'items', 'hours', 'payments', 'staff'];
const SECTION: Record<Tab, ReportSection> = {
  summary: 'days',
  items: 'items',
  hours: 'hours',
  payments: 'tenders',
  staff: 'staff',
};
const PRESETS: readonly RangePreset[] = ['today', 'yesterday', 'last7', 'last30', 'month'];

const label = (t: Dict, key: string, fallback: string): string =>
  (t as Record<string, string>)[key] ?? fallback;
const clock = () => Date.now();

/** Sales reports for one shop or all shops, with CSV export (the export is audited). */
export function ReportsPage({ ctx }: { ctx: PageContext }) {
  const { t, lang } = useI18n();
  const canView = ctx.isOwner || ctx.permissions.includes('report.view');
  const [storeId, setStoreId] = useState('');
  const [range, setRange] = useState(() => presetRange('today', clock()));
  // which quick button the figures on screen belong to; null once the dates are typed by hand
  const [preset, setPreset] = useState<RangePreset | null>('today');
  const [tab, setTab] = useState<Tab>('summary');
  const [exportError, setExportError] = useState<ErrorKey | null>(null);
  const money = (n: number) => formatTHB(n, lang === 'th' ? 'th-TH' : 'en-GB');

  const shops = useRemote(async () => {
    const { data, error } = await ctx.client
      .from('stores')
      .select('id, name')
      .eq('org_id', ctx.orgId)
      .is('deleted_at', null)
      .order('created_at');
    if (error) throw new Error(error.code ?? 'query');
    return (data ?? []) as { id: string; name: string }[];
  }, ctx.orgId);

  // what the company owes its customers in unspent Credit (a liability, not revenue); empty while Credit is unused
  const credit = useRemote(async () => {
    if (!canView) return [];
    const { data, error } = await ctx.client.rpc('credit_liability', { p_org: ctx.orgId });
    if (error || !Array.isArray(data)) return [];
    return (data as { name?: unknown; outstanding?: unknown; customers?: unknown }[])
      .map((x) => ({
        name: typeof x.name === 'string' ? x.name : '',
        outstanding: typeof x.outstanding === 'number' ? x.outstanding : 0,
        customers: typeof x.customers === 'number' ? x.customers : 0,
      }))
      .filter((x) => x.outstanding !== 0);
  }, ctx.orgId);

  const report = useRemote(async (): Promise<SalesReport> => {
    if (!canView) throw new Error('forbidden');
    const { data, error } = await ctx.client.rpc('sales_report', {
      p: { org_id: ctx.orgId, store_id: storeId || null, from: range.from, to: range.to },
    });
    if (error) throw new Error(error.code ?? 'query');
    return parseSalesReport(data);
  }, `${ctx.orgId}|${storeId}|${range.from}|${range.to}`);

  // product returns of the same period and shop (by the day the money went back)
  const returns = useRemote(async () => {
    if (!canView) return null;
    const { data, error } = await ctx.client.rpc('returns_report', {
      p: { org_id: ctx.orgId, store_id: storeId || null, from: range.from, to: range.to },
    });
    if (error) return null;
    return parseReturnsReport(data);
  }, `ret|${ctx.orgId}|${storeId}|${range.from}|${range.to}`);

  if (!canView) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.repNoAccess}</Notice>
      </div>
    );
  }

  const exportCsv = async () => {
    if (!report.data) return;
    setExportError(null);
    const csv = reportCsv(report.data, SECTION[tab]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${SECTION[tab]}-${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    const { error } = await ctx.client.rpc('write_audit', {
      p_org: ctx.orgId,
      p_store: storeId || null,
      p_action: 'export.report',
      p_entity: 'sales_report',
      p_entity_id: null,
      p_detail: { section: SECTION[tab], from: range.from, to: range.to },
    });
    if (error) setExportError('err_load_failed');
  };

  const tabLabel: Record<Tab, string> = {
    summary: t.repTabSummary,
    items: t.repTabItems,
    hours: t.repTabHours,
    payments: t.repTabPayments,
    staff: t.repTabStaff,
  };
  const presetLabel: Record<RangePreset, string> = {
    today: t.repPresetToday,
    yesterday: t.repPresetYesterday,
    last7: t.repPresetLast7,
    last30: t.repPresetLast30,
    month: t.repPresetMonth,
  };
  const r = report.data;

  return (
    <div className="admin-page">
      <h1>{t.repTitle}</h1>
      <section className="card admin-card">
        <div className="filters">
          {(shops.data?.length ?? 0) > 1 ? (
            <div className="form-row">
              <label className="label" htmlFor="rep-shop">
                {t.repShop}
              </label>
              <select
                id="rep-shop"
                className="field"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
              >
                <option value="">{t.repAllShops}</option>
                {(shops.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="rep-from">
              {t.repFrom}
            </label>
            <input
              id="rep-from"
              className="field"
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => {
                if (!e.target.value) return;
                setPreset(null);
                setRange((x) => ({ ...x, from: e.target.value }));
              }}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="rep-to">
              {t.repTo}
            </label>
            <input
              id="rep-to"
              className="field"
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => {
                if (!e.target.value) return;
                setPreset(null);
                setRange((x) => ({ ...x, to: e.target.value }));
              }}
            />
          </div>
        </div>
        <div className="chips" role="group" aria-label={t.repPresetsLabel}>
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              aria-pressed={preset === p}
              onClick={() => {
                setPreset(p);
                setRange(presetRange(p, clock()));
              }}
            >
              {presetLabel[p]}
            </button>
          ))}
        </div>
      </section>

      {ctx.isModuleOn?.('ai.assistant') ? (
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={() => ctx.navigate('/ask')}>
            {t.askShopTitle}
          </button>
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className="tab"
            onClick={() => setTab(k)}
          >
            {tabLabel[k]}
          </button>
        ))}
      </div>

      <section className="card admin-card">
        {report.status === 'loading' ? (
          <p className="sso-working" role="status">
            <Spinner /> {t.loading}
          </p>
        ) : report.status === 'error' || !r ? (
          <>
            <Notice kind="error">{t.err_load_failed}</Notice>
            <AsyncButton variant="secondary" onClick={report.reload}>
              {t.retry}
            </AsyncButton>
          </>
        ) : r.totals.bills === 0 ? (
          <p className="muted">{t.repEmpty}</p>
        ) : (
          <ReportBody t={t} r={r} tab={tab} money={money} />
        )}
        {tab === 'summary' && returns.data ? (
          <ReturnsBlock t={t} data={returns.data} sales={r?.totals.payable ?? 0} money={money} />
        ) : null}
        {exportError ? <Notice kind="error">{errorText(exportError, t)}</Notice> : null}
        <div className="actions">
          <AsyncButton onClick={exportCsv} disabled={!r || r.totals.bills === 0}>
            {t.repExport}
          </AsyncButton>
        </div>
        <p className="muted hint">{t.repNote}</p>
      </section>

      {tab === 'summary' && (credit.data?.length ?? 0) > 0 ? (
        <section className="card admin-card" aria-label={t.repCreditTitle}>
          <h2>{t.repCreditTitle}</h2>
          <Table
            head={[t.repCreditEntity, t.repCreditCustomers, t.repCreditOutstanding]}
            rows={(credit.data ?? []).map((c) => [
              c.name,
              String(c.customers),
              money(c.outstanding),
            ])}
          />
        </section>
      ) : null}
    </div>
  );
}

function ReportBody({
  t,
  r,
  tab,
  money,
}: {
  t: Dict;
  r: SalesReport;
  tab: Tab;
  money: (n: number) => string;
}) {
  if (tab === 'summary')
    return (
      <>
        <dl className="kpis">
          <Kpi name={t.repSales} value={money(r.totals.payable)} />
          <Kpi name={t.repBills} value={String(r.totals.bills)} />
          <Kpi name={t.repAverage} value={money(r.totals.average)} />
          <Kpi name={t.repVat} value={money(r.totals.vat)} />
          <Kpi name={t.repService} value={money(r.totals.serviceCharge)} />
          <Kpi name={t.repRounding} value={money(r.totals.rounding)} />
        </dl>
        <h2>{t.repByDay}</h2>
        <Table
          head={[t.repColDate, t.repColBills, t.repColAmount]}
          rows={r.byDay.map((d) => [d.date, String(d.bills), money(d.payable)])}
        />
        {r.byStore.length > 1 ? (
          <>
            <h2>{t.repByShop}</h2>
            <Table
              head={[t.repColShop, t.repColBills, t.repColAmount]}
              rows={r.byStore.map((s) => [s.name, String(s.bills), money(s.payable)])}
            />
          </>
        ) : null}
      </>
    );
  if (tab === 'items')
    return (
      <Table
        head={[t.repColItem, t.repColQty, t.repColAmount]}
        rows={r.byItem.map((i) => [i.nameTh || i.nameEn, String(i.quantity), money(i.revenue)])}
      />
    );
  if (tab === 'hours')
    return (
      <Table
        head={[t.repColHour, t.repColBills, t.repColAmount]}
        rows={r.byHour.map((h) => [
          `${String(h.hour).padStart(2, '0')}:00`,
          String(h.bills),
          money(h.payable),
        ])}
      />
    );
  if (tab === 'payments')
    return (
      <Table
        head={[t.repColTender, t.repColBills, t.repColAmount]}
        rows={r.byTender.map((x) => [
          label(t, `repTender_${x.tender}`, x.tender),
          String(x.bills),
          money(x.amount),
        ])}
      />
    );
  return (
    <Table
      head={[t.repColStaff, t.repColBills, t.repColAmount]}
      rows={r.byStaff.map((s) => [s.name || t.repNoName, String(s.bills), money(s.payable)])}
    />
  );
}

function ReturnsBlock({
  t,
  data,
  sales,
  money,
}: {
  t: Dict;
  data: ReturnType<typeof parseReturnsReport>;
  sales: number;
  money: (n: number) => string;
}) {
  const method = (m: string) =>
    m === 'cash'
      ? t.returnMethodCash
      : m === 'credit'
        ? t.returnMethodCredit
        : t.returnMethodManual;
  const reason = (x: string) =>
    x === 'wrong_item'
      ? t.returnReasonWrong
      : x === 'defective'
        ? t.returnReasonDefective
        : x === 'changed_mind'
          ? t.returnReasonChanged
          : t.returnReasonOther;
  return (
    <>
      <h2>{t.repReturnsTitle}</h2>
      {data.totals.returns === 0 ? (
        <p className="muted">{t.repReturnsNone}</p>
      ) : (
        <>
          <dl className="kpis">
            <Kpi name={t.repReturnsCount} value={String(data.totals.returns)} />
            <Kpi name={t.repReturnsUnits} value={String(data.totals.units)} />
            <Kpi name={t.repReturnsRefunded} value={money(data.totals.refunded)} />
            <Kpi name={t.repReturnsNet} value={money(sales - data.totals.refunded)} />
          </dl>
          <Table
            head={[
              t.repReturnsNumber,
              t.repReturnsBill,
              t.repReturnsMethod,
              t.repReturnsReason,
              t.repColAmount,
            ]}
            rows={data.rows.map((x) => [
              x.number,
              x.bill,
              method(x.method),
              reason(x.reason),
              money(x.amount),
            ])}
          />
        </>
      )}
    </>
  );
}

function Kpi({ name, value }: { name: string; value: string }) {
  return (
    <div className="kpi">
      <dt className="muted">{name}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td key={j} className={j > 0 ? 'tabular' : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
