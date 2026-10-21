const { createJoinService, JoinError, normalizeCode, hashCode } = require('../../core/services/join-service');

const NEGOCIOS = [{ id: 'BIZ-A', nombre: 'Finca A', farmId: 'farm-A' }, { id: 'BIZ-B', nombre: 'Finca B', farmId: 'farm-B' }];
const NOW = new Date('2026-10-21T12:00:00Z');

function build({ code = 'ABCD-EFGH', over = {} } = {}) {
  const db = {
    firebase_identities: [
      { firebase_uid: 'owner-uid', profile_id: 'p-owner', status: 'active' },
      { firebase_uid: 'owner-b-uid', profile_id: 'p-owner-b', status: 'active' },
      { firebase_uid: 'stuck-uid', profile_id: 'p-stuck', status: 'pending' },
    ],
    farm_members: [{ user_id: 'p-owner', farm_id: 'farm-A', role: 'owner' }, { user_id: 'p-owner-b', farm_id: 'farm-B', role: 'owner' }],
    join_codes: [{ id: 'c1', farm_id: 'farm-A', code_hash: hashCode(normalizeCode(code)), role: 'staff', max_uses: 1, uses: 0,
      expires_at: '2026-10-22T12:00:00Z', revoked_at: null, ...over }],
    join_requests: [],
  };
  const match = (row, params) => Object.entries(params).every(([k, v]) => {
    if (['select', 'limit', 'order'].includes(k)) return true;
    const s = String(v); return s.startsWith('eq.') ? String(row[k]) === s.slice(3) : true;
  });
  const get = jest.fn(async (t, p = {}) => db[t].filter(r => match(r, p)).slice(0, p.limit || 99));
  const post = jest.fn(async (t, row) => { const r = { id: `id-${db[t].length + 1}`, status: 'pending', ...row }; db[t].push(r); return [r]; });
  const patch = jest.fn(async (t, p, f) => { const rows = db[t].filter(r => match(r, p)); rows.forEach(r => Object.assign(r, f)); return rows; });
  const createProfile = jest.fn(async () => 'p-new');
  const svc = createJoinService({ get, post, patch, getNegocios: () => NEGOCIOS, createProfile, log: { log: jest.fn(), error: jest.fn() }, now: () => NOW });
  return { svc, db, get, post, patch, createProfile };
}
const owner = { uid: 'owner-uid' };
const newbie = { uid: 'new-uid', name: 'Luis', email: 'luis@gmail.com' };
const expectErr = async (p, status, code) => {
  await expect(p).rejects.toBeInstanceOf(JoinError);
  await p.catch(e => { expect(e.status).toBe(status); expect(e.code).toBe(code); });
};

describe('createCode', () => {
  test('owner gets a code once; only its hash is stored', async () => {
    const b = build();
    const r = await b.svc.createCode(owner, { businessId: 'BIZ-A' });
    expect(r.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = b.db.join_codes[b.db.join_codes.length - 1];
    expect(stored.code_hash).toBe(hashCode(normalizeCode(r.code)));
    expect(JSON.stringify(stored)).not.toContain(normalizeCode(r.code));
    expect(stored.expires_at).toBe('2026-10-23T12:00:00.000Z');
  });
  test('clamps ttl and uses', async () => {
    const b = build();
    await b.svc.createCode(owner, { businessId: 'BIZ-A', ttlHours: 99999, maxUses: 500 });
    const s = b.db.join_codes.pop();
    expect(s.max_uses).toBe(20); expect(new Date(s.expires_at) - NOW).toBe(168 * 3600 * 1000);
  });
  test('only invitable roles (staff): owner and manager are refused', async () => {
    await expectErr(build().svc.createCode(owner, { businessId: 'BIZ-A', role: 'owner' }), 400, 'invalid-role');
    await expectErr(build().svc.createCode(owner, { businessId: 'BIZ-A', role: 'manager' }), 400, 'invalid-role');
  });
  test('non-owner, owner of another business, unknown business are refused', async () => {
    const b = build();
    await expectErr(b.svc.createCode({ uid: 'nobody' }, { businessId: 'BIZ-A' }), 403, 'forbidden');
    await expectErr(b.svc.createCode({ uid: 'owner-b-uid' }, { businessId: 'BIZ-A' }), 403, 'forbidden');
    await expectErr(b.svc.createCode(owner, { businessId: 'BIZ-X' }), 404, 'unknown-business');
    await expectErr(b.svc.createCode({ uid: 'stuck-uid' }, { businessId: 'BIZ-A' }), 403, 'forbidden');
  });
});

describe('submit', () => {
  test('valid code creates a pending request and grants nothing', async () => {
    const b = build();
    expect(await b.svc.submit(newbie, 'abcd efgh')).toEqual({ status: 'join_pending', businessName: 'Finca A' });
    expect(b.db.join_requests).toHaveLength(1);
    expect(b.db.join_requests[0]).toMatchObject({ farm_id: 'farm-A', firebase_uid: 'new-uid', requested_role: 'staff' });
    expect(b.db.farm_members).toHaveLength(2);                // unchanged
    expect(b.db.join_codes[0].uses).toBe(1);
  });
  test.each([
    ['wrong code', 'ZZZZ-ZZZZ', {}], ['too short', 'ABC', {}],
    ['expired', 'ABCD-EFGH', { expires_at: '2026-10-21T11:00:00Z' }],
    ['revoked', 'ABCD-EFGH', { revoked_at: '2026-10-21T10:00:00Z' }],
    ['used up', 'ABCD-EFGH', { uses: 1 }],
  ])('%s -> the same generic error, nothing written', async (_l, input, over) => {
    const b = build({ over });
    await expectErr(b.svc.submit(newbie, input), 400, 'invalid-code');
    expect(b.db.join_requests).toHaveLength(0);
  });
  test('asking twice does not consume another use', async () => {
    const b = build({ over: { max_uses: 5 } });
    await b.svc.submit(newbie, 'ABCD-EFGH'); await b.svc.submit(newbie, 'ABCD-EFGH');
    expect(b.db.join_requests).toHaveLength(1); expect(b.db.join_codes[0].uses).toBe(1);
  });
  test('an existing member is told so', async () => {
    expect(await build().svc.submit(owner, 'ABCD-EFGH')).toEqual({ status: 'already_member' });
  });
  test('losing the race for the last use is refused', async () => {
    const b = build(); b.patch.mockResolvedValueOnce([]);
    await expectErr(b.svc.submit(newbie, 'ABCD-EFGH'), 400, 'invalid-code');
    expect(b.db.join_requests).toHaveLength(0);
  });
});

describe('listRequests and decide', () => {
  async function withRequest() { const b = build(); await b.svc.submit(newbie, 'ABCD-EFGH'); return b; }

  test('owner lists only their business requests', async () => {
    const b = await withRequest();
    expect(await b.svc.listRequests(owner, 'BIZ-A')).toEqual([expect.objectContaining({ name: 'Luis', email: 'luis@gmail.com', role: 'staff' })]);
    expect(await b.svc.listRequests({ uid: 'owner-b-uid' }, 'BIZ-B')).toEqual([]);
    await expectErr(b.svc.listRequests({ uid: 'owner-b-uid' }, 'BIZ-A'), 403, 'forbidden');
  });
  test('approve creates profile, identity link and membership', async () => {
    const b = await withRequest(); const id = b.db.join_requests[0].id;
    expect(await b.svc.decide(owner, 'BIZ-A', id, true)).toEqual({ status: 'approved' });
    expect(b.createProfile).toHaveBeenCalledWith({ email: 'luis@gmail.com', fullName: 'Luis' });
    expect(b.db.farm_members).toContainEqual(expect.objectContaining({ farm_id: 'farm-A', user_id: 'p-new', role: 'staff' }));
    expect(b.db.firebase_identities).toContainEqual(expect.objectContaining({ firebase_uid: 'new-uid', profile_id: 'p-new', status: 'active' }));
    expect(b.db.join_requests[0]).toMatchObject({ status: 'approved', decided_by: 'p-owner' });
  });
  test('reject changes nothing else', async () => {
    const b = await withRequest(); const id = b.db.join_requests[0].id;
    await b.svc.decide(owner, 'BIZ-A', id, false);
    expect(b.createProfile).not.toHaveBeenCalled(); expect(b.db.farm_members).toHaveLength(2);
    expect(b.db.join_requests[0].status).toBe('rejected');
  });
  test('another business owner cannot decide it (looks missing)', async () => {
    const b = await withRequest(); const id = b.db.join_requests[0].id;
    await expectErr(b.svc.decide({ uid: 'owner-b-uid' }, 'BIZ-B', id, true), 404, 'not-found');
    expect(b.db.farm_members).toHaveLength(2);
  });
  test('cannot be decided twice', async () => {
    const b = await withRequest(); const id = b.db.join_requests[0].id;
    await b.svc.decide(owner, 'BIZ-A', id, true);
    await expectErr(b.svc.decide(owner, 'BIZ-A', id, true), 409, 'already-decided');
  });
  test('profile creation failure grants nothing', async () => {
    const b = await withRequest(); b.createProfile.mockResolvedValue(null);
    await expectErr(b.svc.decide(owner, 'BIZ-A', b.db.join_requests[0].id, true), 502, 'profile-failed');
    expect(b.db.farm_members).toHaveLength(2); expect(b.db.join_requests[0].status).toBe('pending');
  });
  test('an account with an unresolved identity link is not silently overwritten', async () => {
    const b = build(); await b.svc.submit({ uid: 'stuck-uid', email: 's@x.com' }, 'ABCD-EFGH');
    await expectErr(b.svc.decide(owner, 'BIZ-A', b.db.join_requests[0].id, true), 409, 'identity-unresolved');
  });
});
