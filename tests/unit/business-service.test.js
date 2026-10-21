const { createBusinessService, slugify } = require('../../core/services/business-service');
const { JoinError } = require('../../core/services/join-service');

const NOW = new Date('2026-10-21T12:00:00Z');
function build(over = {}) {
  const db = {
    firebase_identities: [{ firebase_uid: 'admin-uid', profile_id: 'p-admin', status: 'active' }, { firebase_uid: 'owner-uid', profile_id: 'p-owner', status: 'active' }, { firebase_uid: 'stuck-uid', profile_id: 'p-s', status: 'pending' }],
    profiles: [{ id: 'p-admin', role: 'admin' }, { id: 'p-owner', role: 'customer' }],
    business_requests: [], farms: [{ id: 'f0', slug: 'finca-rosal' }], farm_members: [],
  };
  const match = (row, params) => Object.entries(params).every(([k, v]) => {
    if (['select', 'limit', 'order'].includes(k)) return true;
    const s = String(v); return s.startsWith('eq.') ? String(row[k]) === s.slice(3) : true;
  });
  const get = jest.fn(async (t, p = {}) => db[t].filter(r => match(r, p)).slice(0, p.limit || 99));
  const post = jest.fn(async (t, row) => { const r = { id: `id-${t}-${db[t].length + 1}`, status: 'pending', ...row }; db[t].push(r); return [r]; });
  const patch = jest.fn(async (t, p, f) => { const rows = db[t].filter(r => match(r, p)); rows.forEach(r => Object.assign(r, f)); return rows; });
  const createProfile = jest.fn(async () => 'p-new');
  const onApproved = jest.fn(async () => {});
  const svc = createBusinessService({ get, post, patch, createProfile, onApproved, log: { log: jest.fn(), error: jest.fn() }, now: () => NOW, randomSuffix: () => 'x1y2', ...over });
  return { svc, db, createProfile, onApproved, post };
}
const newbie = { uid: 'new-uid', name: 'Luis', email: 'luis@gmail.com' };
const form = { name: 'Café Luis', city: 'Lima', phone: '987 654 321' };
const expectErr = async (p, status, code) => { await expect(p).rejects.toBeInstanceOf(JoinError); await p.catch(e => { expect(e.status).toBe(status); expect(e.code).toBe(code); }); };

test('slugify strips accents and symbols', () => expect(slugify('  Café "Luis" & Hijos! ')).toBe('cafe-luis-hijos'));

describe('submit', () => {
  test('stores a normalized pending request and creates nothing else', async () => {
    const b = build();
    expect(await b.svc.submit(newbie, form)).toEqual({ status: 'business_pending' });
    expect(b.db.business_requests[0]).toMatchObject({ firebase_uid: 'new-uid', business_name: 'Café Luis', city: 'Lima', contact_phone: '51987654321' });
    expect(b.db.farms).toHaveLength(1); expect(b.db.farm_members).toHaveLength(0);
  });
  test.each([
    ['short name', { name: 'ab' }, 'invalid-name'], ['long name', { name: 'x'.repeat(81) }, 'invalid-name'],
    ['no city', { city: '' }, 'invalid-city'], ['bad phone', { phone: '123' }, 'invalid-phone'],
  ])('%s is refused', async (_l, over, code) => {
    const b = build(); await expectErr(b.svc.submit(newbie, { ...form, ...over }), 400, code);
    expect(b.db.business_requests).toHaveLength(0);
  });
  test('a second submit while pending does not create another', async () => {
    const b = build(); await b.svc.submit(newbie, form); await b.svc.submit(newbie, form);
    expect(b.db.business_requests).toHaveLength(1);
  });
});

describe('admin actions', () => {
  const admin = { uid: 'admin-uid' };
  async function pending() { const b = build(); await b.svc.submit(newbie, form); return b; }

  test('only a platform admin can list or decide', async () => {
    const b = await pending(); const id = b.db.business_requests[0].id;
    for (const who of [{ uid: 'owner-uid' }, { uid: 'nobody' }, { uid: 'stuck-uid' }]) {
      await expectErr(b.svc.listPending(who), 403, 'forbidden');
      await expectErr(b.svc.decide(who, id, true), 403, 'forbidden');
    }
    expect(b.db.farms).toHaveLength(1);
  });
  test('admin sees pending requests', async () => {
    const b = await pending();
    expect(await b.svc.listPending(admin)).toEqual([expect.objectContaining({ businessName: 'Café Luis', city: 'Lima', phone: '51987654321', email: 'luis@gmail.com' })]);
  });
  test('approve creates farm, owner membership and identity link, then reloads businesses', async () => {
    const b = await pending(); const id = b.db.business_requests[0].id;
    expect(await b.svc.decide(admin, id, true)).toEqual({ status: 'approved' });
    const farm = b.db.farms[1];
    expect(farm).toMatchObject({ slug: 'cafe-luis', name: 'Café Luis', status: 'approved', owner_id: 'p-new', contact_phone: '51987654321' });
    expect(b.db.farm_members).toContainEqual(expect.objectContaining({ farm_id: farm.id, user_id: 'p-new', role: 'owner' }));
    expect(b.db.firebase_identities).toContainEqual(expect.objectContaining({ firebase_uid: 'new-uid', profile_id: 'p-new', status: 'active' }));
    expect(b.db.business_requests[0]).toMatchObject({ status: 'approved', farm_id: farm.id, decided_by: 'p-admin' });
    expect(b.onApproved).toHaveBeenCalledTimes(1);
  });
  test('a taken slug gets a suffix', async () => {
    const b = await pending(); b.db.farms.push({ id: 'f9', slug: 'cafe-luis' });
    await b.svc.decide(admin, b.db.business_requests[0].id, true);
    expect(b.db.farms[2].slug).toBe('cafe-luis-x1y2');
  });
  test('reject creates nothing', async () => {
    const b = await pending();
    expect(await b.svc.decide(admin, b.db.business_requests[0].id, false)).toEqual({ status: 'rejected' });
    expect(b.db.farms).toHaveLength(1); expect(b.createProfile).not.toHaveBeenCalled(); expect(b.onApproved).not.toHaveBeenCalled();
  });
  test('cannot be decided twice; unknown id is 404', async () => {
    const b = await pending(); const id = b.db.business_requests[0].id;
    await b.svc.decide(admin, id, false);
    await expectErr(b.svc.decide(admin, id, true), 409, 'already-decided');
    await expectErr(b.svc.decide(admin, 'nope', true), 404, 'not-found');
  });
  test('profile failure grants nothing and leaves the request pending', async () => {
    const b = await pending(); b.createProfile.mockResolvedValue(null);
    await expectErr(b.svc.decide(admin, b.db.business_requests[0].id, true), 502, 'profile-failed');
    expect(b.db.farms).toHaveLength(1); expect(b.db.business_requests[0].status).toBe('pending');
  });
  test('an existing owner can register another business without a new profile', async () => {
    const b = build(); await b.svc.submit({ uid: 'owner-uid', email: 'o@x.com' }, form);
    await b.svc.decide(admin, b.db.business_requests[0].id, true);
    expect(b.createProfile).not.toHaveBeenCalled();
    expect(b.db.farm_members[0]).toMatchObject({ user_id: 'p-owner', role: 'owner' });
  });
});
