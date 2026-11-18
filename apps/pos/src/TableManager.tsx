import { useState } from 'react';
import { errorText, useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import type { PageContext } from '@bestie/auth';
import type { OrderDoc } from '@bestie/core';
import type { PosTable } from './posData';

const writeError = (code: string | undefined): ErrorKey =>
  code === '42501'
    ? 'err_forbidden'
    : code === '23505' || code === '23514'
      ? 'err_table_invalid'
      : 'err_save_failed';

/** Add, rename and remove tables. Needs `menu.edit` and a connection (the floor plan is shop setup, not till work). */
export function TableManager({
  ctx,
  storeId,
  tables,
  orders,
  onChanged,
}: {
  ctx: PageContext;
  storeId: string;
  tables: PosTable[];
  orders: OrderDoc[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <section className="card admin-card">
      <h2>{t.tablesManage}</h2>
      <p className="muted">{t.tablesManageHint}</p>
      {!open ? (
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
          {t.tablesManage}
        </button>
      ) : (
        <>
          <ul className="member-list">
            {tables.map((tb) => (
              <TableRow
                key={tb.id}
                ctx={ctx}
                table={tb}
                busy={orders.some((o) => o.tableId === tb.id)}
                onChanged={onChanged}
              />
            ))}
          </ul>
          <TableForm
            idPrefix="tbl-new"
            label={t.tableAdd}
            onSave={async (v) => {
              const { error } = await ctx.client.from('dining_tables').insert({
                id: crypto.randomUUID(),
                org_id: ctx.orgId,
                store_id: storeId,
                name: v.name,
                zone: v.zone,
                seats: v.seats,
                sort: Math.max(0, ...tables.map((x) => x.sort)) + 10,
              });
              if (error) return writeError(error.code);
              onChanged();
              return null;
            }}
            clearOnSave
          />
        </>
      )}
    </section>
  );
}

function TableRow({
  ctx,
  table,
  busy,
  onChanged,
}: {
  ctx: PageContext;
  table: PosTable;
  busy: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [blocked, setBlocked] = useState(false);

  const remove = async () => {
    setError(null);
    if (busy) return setBlocked(true);
    setBlocked(false);
    const { data, error: err } = await ctx.client
      .from('dining_tables')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', table.id)
      .select('id');
    if (err || data?.length !== 1) return setError(writeError(err?.code));
    onChanged();
  };

  return (
    <li className="member-row">
      <div className="member-head">
        <strong>{table.name}</strong>
        <span className="muted">{table.zone}</span>
        <button type="button" className="btn btn-secondary" onClick={() => setEditing(!editing)}>
          {t.menuEdit}
        </button>
        <AsyncButton variant="secondary" onClick={remove}>
          {t.tableRemove}
        </AsyncButton>
      </div>
      {blocked ? <Notice kind="error">{t.tableRemoveBlocked}</Notice> : null}
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {editing ? (
        <TableForm
          idPrefix={`tbl-${table.id}`}
          label={t.tableSave}
          initial={table}
          onSave={async (v) => {
            const { data, error: err } = await ctx.client
              .from('dining_tables')
              .update({ name: v.name, zone: v.zone, seats: v.seats })
              .eq('id', table.id)
              .select('id');
            if (err || data?.length !== 1) return writeError(err?.code);
            setEditing(false);
            onChanged();
            return null;
          }}
        />
      ) : null}
    </li>
  );
}

function TableForm({
  idPrefix,
  label,
  initial,
  onSave,
  clearOnSave = false,
}: {
  idPrefix: string;
  label: string;
  initial?: PosTable;
  onSave: (v: { name: string; zone: string; seats: number }) => Promise<ErrorKey | null>;
  clearOnSave?: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? '');
  const [zone, setZone] = useState(initial?.zone ?? '');
  const [seats, setSeats] = useState(String(initial?.seats ?? 2));
  const [error, setError] = useState<ErrorKey | null>(null);

  const save = async () => {
    setError(null);
    const n = /^\d{1,2}$/.test(seats.trim()) ? Number(seats) : NaN;
    if (
      name.trim().length < 1 ||
      name.trim().length > 40 ||
      zone.length > 40 ||
      !(n >= 1 && n <= 50)
    )
      return setError('err_table_invalid');
    const err = await onSave({ name: name.trim(), zone: zone.trim(), seats: n });
    if (err) return setError(err);
    if (clearOnSave) {
      setName('');
      setZone('');
    }
  };

  return (
    <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
      <div className="filters">
        <div className="form-row">
          <label className="label" htmlFor={`${idPrefix}-name`}>
            {t.tableName}
          </label>
          <input
            id={`${idPrefix}-name`}
            className="field"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor={`${idPrefix}-zone`}>
            {t.tableZone}
          </label>
          <input
            id={`${idPrefix}-zone`}
            className="field"
            value={zone}
            maxLength={40}
            onChange={(e) => setZone(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor={`${idPrefix}-seats`}>
            {t.tableSeatsLabel}
          </label>
          <input
            id={`${idPrefix}-seats`}
            className="field tabular"
            inputMode="numeric"
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
          />
        </div>
      </div>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      <AsyncButton type="submit" onClick={save}>
        {label}
      </AsyncButton>
    </form>
  );
}
