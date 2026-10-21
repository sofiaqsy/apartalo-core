const { createBusinessService, slugify } = require('../../core/services/business-service');
const { JoinError } = require('../../core/services/join-service');

function build() {
  const db = {
    firebase_identities: [
      { firebase_uid: 'admin-uid', profile_id: 'p-admin', status: 'active' },
      { firebase_uid: 'plain-uid', profile_id: 'p-plain', status: 'active' },
      { firebase_uid: 'stuck-uid', profile_id: 'p-s', status: 'pending' },
    ],
    profiles: [
      { id: 'p-admin', is_admin: true, email: 'admin@x.com' }, { id: 'p-plain', is_admin: false, email: 'plain@x.com', full_name: 'Plain' },
      { id: 'p-cust', is_admin: false, email: 'cust@x.com' }, { id: 'p-boss', is_admin: false, email: 'boss@x.com' },
      { id: 'p-adm2', is_admin: true, email: 'adm2@x.com' },
    ],
    farm_members: [{ user_id: 'p-boss', farm_id: 'f0', role: 'owner' }],
    farms: [{ id: 'f0', slug: 'finca-rosal', status: 'approved' }],
  };
  const match = (row, params) => Object.entries(params).every(([k, v]) => {
    if (['select', 'limit', 'order'].includes(k)) return true;
    const s = String(v); return s.startsWith('eq.') ? String(row[k]) === s.slice(3) : true;
  });
  const get = jest.fn(async (t, p = {}) => db[t].filter(r => match(r, p)).slice(0, p.limit || 99));
  const post = jest.fn(async (t, row) => { const r = { id: `id-${t}-${db[t].length + 1}`, ...row }; db[t].push(r); return [r]; });
  const patch = jest.fn(async (t, p, f) => { const rows = db[t].filter(r => match(r, p)); rows.forEach(r => Object.assign(r, f)); return rows; });
  const createProfile = jest.fn(async () => { db.profiles.push({ id: 'p-new', is_admin: false }); return 'p-new'; });
  const onApproved = jest.fn(async () => {});
  const svc = createBusinessService({ get, post, patch, createProfile, onApproved, log: { log: jest.fn(), error: jest.fn() }, randomSuffix: () => 'x1y2' });
  return { svc, db, createProfile, onApproved, post, patch };
}
const newbie = { uid: 'new-uid', name: 'Luis', email: 'luis@gmail.com', emailVerified: true, provider: 'google.com' };
const form = { name: 'Café Luis', city: 'Lima', phone: '987 654 321' };
const expectErr = async (p, status, code) => { await expect(p).rejects.toBeInstanceOf(JoinError); await p.catch(e => { expect(e.status).toBe(status); expect(e.code).toBe(code); }); };

test('slugify strips accents and symbols', () => expect(slugify('  Café "Luis" & Hijos! ')).toBe('cafe-luis-hijos'));

describe('submit', () => {
  test('new person: creates profile, identity link and a PENDING farm; no membership', async () => {
    const b = build();
    expect(await b.svc.submit(newbie, form)).toEqual({ status: 'business_pending' });
    expect(b.createProfile).toHaveBeenCalledWith({ email: 'luis@gmail.com', fullName: 'Luis' });
    expect(b.db.firebase_identities).toContainEqual(expect.objectContaining({ firebase_uid: 'new-uid', profile_id: 'p-new', status: 'active' }));
    expect(b.db.farms[1]).toMatchObject({ slug: 'cafe-luis', name: 'Café Luis', status: 'pending', owner_id: 'p-new', contact_phone: '51987654321', kind: 'hybrid' });
    expect(b.db.farm_members).toHaveLength(1);                 // untouched: the database trigger adds it on approval
  });
  test('an existing plain profile with the same verified email is reused', async () => {
    const b = build();
    await b.svc.submit({ ...newbie, email: 'cust@x.com' }, form);
    expect(b.createProfile).not.toHaveBeenCalled();
    expect(b.db.farms[1].owner_id).toBe('p-cust');
  });
  test.each([['a member', 'boss@x.com'], ['a platform admin', 'adm2@x.com']])('never takes over the profile of %s', async (_l, email) => {
    const b = build();
    await expectErr(b.svc.submit({ ...newbie, email }, form), 409, 'identity-unresolved');
    expect(b.db.farms).toHaveLength(1); expect(b.db.firebase_identities).toHaveLength(3);
  });
  test('unverified or missing email is refused', async () => {
    const b = build();
    await expectErr(b.svc.submit({ ...newbie, emailVerified: false }, form), 422, 'email-required');
    await expectErr(b.svc.submit({ ...newbie, email: null }, form), 422, 'email-required');
  });
  test('an unresolved (pending) identity link is not bypassed', async () => {
    await expectErr(build().svc.submit({ uid: 'stuck-uid', email: 's@x.com', emailVerified: true }, form), 409, 'identity-unresolved');
  });
  test.each([
    ['short name', { name: 'ab' }, 'invalid-name'], ['long name', { name: 'x'.repeat(81) }, 'invalid-name'],
    ['no city', { city: '' }, 'invalid-city'], ['bad phone', { phone: '123' }, 'invalid-phone'],
  ])('%s is refused before touching the database', async (_l, over, code) => {
    const b = build(); await expectErr(b.svc.submit(newbie, { ...form, ...over }), 400, code);
    expect(b.post).not.toHaveBeenCalled();
  });
  test('asking again while pending creates no second farm', async () => {
    const b = build(); await b.svc.submit(newbie, form); await b.svc.submit(newbie, form);
    expect(b.db.farms.filter(f => f.status === 'pending')).toHaveLength(1);
  });
  test('a taken slug gets a suffix', async () => {
    const b = build(); b.db.farms.push({ id: 'f9', slug: 'cafe-luis', status: 'approved' });
    await b.svc.submit(newbie, form);
    expect(b.db.farms[2].slug).toBe('cafe-luis-x1y2');
  });
});

describe('pending status and admin actions', () => {
  const admin = { uid: 'admin-uid' };
  async function pending() { const b = build(); await b.svc.submit(newbie, form); return b; }

  test('pendingFor shows the open request of that person only', async () => {
    const b = await pending();
    expect(await b.svc.pendingFor('new-uid')).toEqual([{ businessName: 'Café Luis' }]);
    expect(await b.svc.pendingFor('plain-uid')).toEqual([]);
    expect(await b.svc.pendingFor('nobody')).toEqual([]);
  });
  test('only a platform admin (is_admin) can list or decide', async () => {
    const b = await pending(); const id = b.db.farms[1].id;
    for (const who of [{ uid: 'plain-uid' }, { uid: 'nobody' }, { uid: 'stuck-uid' }, { uid: 'new-uid' }]) {
      await expectErr(b.svc.listPending(who), 403, 'forbidden');
      await expectErr(b.svc.decide(who, id, true), 403, 'forbidden');
    }
    expect(b.db.farms[1].status).toBe('pending');
  });
  test('admin lists pending farms with owner name and contact', async () => {
    const b = await pending();
    expect(await b.svc.listPending(admin)).toEqual([expect.objectContaining({ businessName: 'Café Luis', city: 'Lima', phone: '51987654321', email: 'luis@gmail.com' })]);
  });
  test('approve only flips the status (the trigger does the rest) and reloads businesses', async () => {
    const b = await pending(); const id = b.db.farms[1].id;
    expect(await b.svc.decide(admin, id, true)).toEqual({ status: 'approved' });
    expect(b.db.farms[1].status).toBe('approved');
    expect(b.db.farm_members).toHaveLength(1);
    expect(b.onApproved).toHaveBeenCalledTimes(1);
    expect(b.patch).toHaveBeenCalledWith('farms', { id: `eq.${id}`, status: 'eq.pending' }, { status: 'approved' });
  });
  test('reject marks it rejected without reloading', async () => {
    const b = await pending();
    expect(await b.svc.decide(admin, b.db.farms[1].id, false)).toEqual({ status: 'rejected' });
    expect(b.db.farms[1].status).toBe('rejected'); expect(b.onApproved).not.toHaveBeenCalled();
  });
  test('cannot decide twice, an approved farm, or an unknown id', async () => {
    const b = await pending(); const id = b.db.farms[1].id;
    await b.svc.decide(admin, id, false);
    await expectErr(b.svc.decide(admin, id, true), 409, 'already-decided');
    await expectErr(b.svc.decide(admin, 'f0', false), 409, 'already-decided');
    await expectErr(b.svc.decide(admin, 'nope', true), 404, 'not-found');
  });
});
