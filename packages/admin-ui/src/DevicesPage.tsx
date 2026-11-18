import { useState } from 'react';
import { DEVICE_ROLES, KDS_STATIONS, deviceProblems } from '@bestie/core';
import type { DeviceRole, KdsStation } from '@bestie/core';
import { errorText, fmt, useI18n } from '@bestie/i18n';
import type { Dict, ErrorKey } from '@bestie/i18n';
import { AsyncButton, Spinner } from '@bestie/ui';
import { Notice } from '@bestie/auth';
import { setDeviceBinding, useDeviceBinding } from '@bestie/offline';
import type { PageContext } from '@bestie/auth';
import { useRemote } from './useRemote';

type DeviceRow = {
  id: string;
  store_id: string;
  name: string;
  code: string | null;
  role: DeviceRole;
  station: KdsStation | null;
  revenue_pos_id: string | null;
  active: boolean;
};
type StoreRow = { id: string; name: string; vat_registered: boolean };

const tx = (t: Dict, key: string): string => (t as Record<string, string>)[key] ?? key;

const saveError = (code: string | undefined): ErrorKey =>
  code === '42501' ? 'err_forbidden' : code === '23514' ? 'err_device_invalid' : 'err_save_failed';

/** Owner: register the shop's tablets, what each is for, and the Revenue Department POS ID printed on receipts. */
export function DevicesPage({ ctx }: { ctx: PageContext }) {
  const { t } = useI18n();
  const canEdit = ctx.isOwner || ctx.permissions.includes('settings.manage');
  const { status, data, reload } = useRemote(async () => {
    const [devices, stores] = await Promise.all([
      ctx.client
        .from('devices')
        .select('id, store_id, name, code, role, station, revenue_pos_id, active')
        .eq('org_id', ctx.orgId)
        .order('created_at'),
      ctx.client
        .from('stores')
        .select('id, name, vat_registered')
        .eq('org_id', ctx.orgId)
        .is('deleted_at', null)
        .order('created_at'),
    ]);
    if (devices.error || stores.error) throw new Error('load');
    return {
      devices: (devices.data ?? []) as DeviceRow[],
      stores: (stores.data ?? []) as StoreRow[],
    };
  }, ctx.orgId);

  if (status === 'loading')
    return (
      <p className="sso-working" role="status">
        <Spinner /> {t.loading}
      </p>
    );
  if (status === 'error' || !data) {
    return (
      <div className="admin-page">
        <Notice kind="error">{t.err_load_failed}</Notice>
        <AsyncButton variant="secondary" onClick={reload}>
          {t.retry}
        </AsyncButton>
      </div>
    );
  }
  const storeName = (id: string) => data.stores.find((s) => s.id === id)?.name ?? '—';
  return (
    <div className="admin-page">
      <h1>{t.devicesTitle}</h1>
      <Notice kind="info">{t.devicesIntro}</Notice>
      <section className="card admin-card">
        <h2>{t.devicesList}</h2>
        {data.devices.length === 0 ? <p className="muted">{t.devicesEmpty}</p> : null}
        <ul className="member-list">
          {data.devices.map((d) => (
            <DeviceItem
              key={d.id}
              ctx={ctx}
              device={d}
              store={storeName(d.store_id)}
              canEdit={canEdit}
              onChanged={reload}
            />
          ))}
        </ul>
      </section>
      {canEdit && data.stores.length > 0 ? (
        <AddDevice ctx={ctx} stores={data.stores} onAdded={reload} />
      ) : null}
    </div>
  );
}

function DeviceItem({
  ctx,
  device,
  store,
  canEdit,
  onChanged,
}: {
  ctx: PageContext;
  device: DeviceRow;
  store: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [posId, setPosId] = useState(device.revenue_pos_id ?? '');
  const here = useDeviceBinding();
  const isHere = here?.deviceId === device.id;
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (values: { revenue_pos_id?: string | null; active?: boolean }) => {
    setError(null);
    setSaved(false);
    const { data: rows, error: err } = await ctx.client
      .from('devices')
      .update(values)
      .eq('id', device.id)
      .select('id');
    if (err || rows?.length !== 1) return setError(saveError(err?.code));
    setSaved(true);
    onChanged();
  };

  const savePos = () => {
    const v = posId.trim();
    if (
      deviceProblems({
        name: device.name,
        role: device.role,
        station: device.station,
        posId: v,
      }).includes('posId')
    )
      return setError('err_device_invalid');
    return save({ revenue_pos_id: v === '' ? null : v });
  };

  return (
    <li className="member-row">
      <div className="member-head">
        <strong>{device.name}</strong>
        <span className="muted">{store}</span>
        <span className="badge">{tx(t, `deviceRole_${device.role}`)}</span>
        {device.station ? (
          <span className="badge">{tx(t, `deviceStation_${device.station}`)}</span>
        ) : null}
        {!device.active ? <span className="badge">{t.deviceOff}</span> : null}
        {isHere ? <span className="badge">{t.deviceHere}</span> : null}
      </div>
      {isHere ? <p className="muted">{fmt(t.deviceBoundNote, { name: device.name })}</p> : null}
      <div className="member-controls">
        <div className="form-row">
          <label className="label" htmlFor={`pos-${device.id}`}>
            {t.devicePosId}
          </label>
          <input
            id={`pos-${device.id}`}
            className="field mono"
            value={posId}
            maxLength={40}
            disabled={!canEdit}
            placeholder={t.deviceNoPosId}
            onChange={(e) => {
              setPosId(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        {canEdit ? (
          <div className="actions">
            <AsyncButton variant="secondary" onClick={savePos}>
              {t.deviceSave}
            </AsyncButton>
            <AsyncButton variant="secondary" onClick={() => save({ active: !device.active })}>
              {device.active ? t.deviceDisable : t.deviceEnable}
            </AsyncButton>
            {device.active || isHere ? (
              <AsyncButton
                variant="secondary"
                onClick={() =>
                  setDeviceBinding(
                    isHere
                      ? null
                      : {
                          deviceId: device.id,
                          storeId: device.store_id,
                          orgId: ctx.orgId,
                          name: device.name,
                          code: device.code ?? 'A',
                          role: device.role,
                          station: device.station,
                          posId: device.revenue_pos_id,
                        },
                  )
                }
              >
                {isHere ? t.deviceUnbind : t.deviceBind}
              </AsyncButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
      {saved ? <Notice kind="success">{t.deviceSaved}</Notice> : null}
    </li>
  );
}

function AddDevice({
  ctx,
  stores,
  onAdded,
}: {
  ctx: PageContext;
  stores: StoreRow[];
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [storeId, setStoreId] = useState(stores[0]!.id);
  const [role, setRole] = useState<DeviceRole>('cashier');
  const [station, setStation] = useState<KdsStation>('kitchen');
  const [posId, setPosId] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [done, setDone] = useState(false);

  const add = async () => {
    setError(null);
    setDone(false);
    const stationValue = role === 'kds' ? station : null;
    if (deviceProblems({ name, role, station: stationValue, posId }).length > 0)
      return setError('err_device_invalid');
    const { error: err } = await ctx.client.from('devices').insert({
      org_id: ctx.orgId,
      store_id: storeId,
      name: name.trim(),
      role,
      station: stationValue,
      revenue_pos_id: posId.trim() === '' ? null : posId.trim(),
    });
    if (err) {
      console.error('[devices] insert failed', err.code ?? 'unknown');
      return setError(saveError(err.code));
    }
    setName('');
    setPosId('');
    setDone(true);
    onAdded();
  };

  return (
    <section className="card admin-card">
      <h2>{t.deviceAdd}</h2>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
        <div className="filters">
          <div className="form-row">
            <label className="label" htmlFor="dev-name">
              {t.deviceName}
            </label>
            <input
              id="dev-name"
              className="field"
              value={name}
              maxLength={60}
              onChange={(e) => {
                setName(e.target.value);
                setDone(false);
              }}
            />
          </div>
          {stores.length > 1 ? (
            <div className="form-row">
              <label className="label" htmlFor="dev-store">
                {t.deviceStore}
              </label>
              <select
                id="dev-store"
                className="field"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="dev-role">
              {t.deviceRole}
            </label>
            <select
              id="dev-role"
              className="field"
              value={role}
              onChange={(e) => setRole(e.target.value as DeviceRole)}
            >
              {DEVICE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {tx(t, `deviceRole_${r}`)}
                </option>
              ))}
            </select>
          </div>
          {role === 'kds' ? (
            <div className="form-row">
              <label className="label" htmlFor="dev-station">
                {t.deviceStation}
              </label>
              <select
                id="dev-station"
                className="field"
                value={station}
                onChange={(e) => setStation(e.target.value as KdsStation)}
              >
                {KDS_STATIONS.map((s) => (
                  <option key={s} value={s}>
                    {tx(t, `deviceStation_${s}`)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="form-row">
            <label className="label" htmlFor="dev-pos">
              {t.devicePosId}
            </label>
            <input
              id="dev-pos"
              className="field mono"
              value={posId}
              maxLength={40}
              aria-describedby="dev-pos-hint"
              onChange={(e) => setPosId(e.target.value)}
            />
            <small id="dev-pos-hint" className="muted">
              {t.devicePosIdHint}
            </small>
          </div>
        </div>
        {error ? <Notice kind="error">{errorText(error, t)}</Notice> : null}
        {done ? <Notice kind="success">{t.deviceAdded}</Notice> : null}
        <AsyncButton type="submit" onClick={add}>
          {t.deviceAdd}
        </AsyncButton>
      </form>
    </section>
  );
}
