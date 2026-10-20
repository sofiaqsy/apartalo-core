const { createIdentityService, normalizePhone } = require('../../core/services/identity-service');

const P_OWNER = 'p-owner', P_CUSTOMER = 'p-customer';
const NEGOCIOS = [{ id: 'BIZ-002', nombre: 'Finca Rosal', direccion: 'Calle 1', ciudad: 'Lima', farmId: 'farm-A' }];

function build({ identities = [], profiles, members } = {}) {
  const db = {
    firebase_identities: identities,
    profiles: profiles || [
      { id: P_OWNER, email: 'ana@gmail.com', phone: null, full_name: 'Ana' },
      { id: P_CUSTOMER, email: '51999111222@whatsapp.apartalo.co', phone: '51999111222', full_name: 'Cli' },
      { id: 'p-other', email: 'dup@x.com', phone: '51988000111' },
      { id: 'p-dup1', email: 'twin@x.com' }, { id: 'p-dup2', email: 'TWIN@x.com' },
    ],
    farm_members: members || [{ user_id: P_OWNER, farm_id: 'farm-A', role: 'owner' }, { user_id: 'p-dup1', farm_id: 'farm-A', role: 'owner' }],
  };
  const match = (row, params) => Object.entries(params).every(([k, v]) => {
    if (['select', 'limit'].includes(k)) return true;
    const s = String(v);
    if (s.startsWith('eq.')) return row[k] === s.slice(3);
    if (s.startsWith('ilike.')) return String(row[k] || '').toLowerCase() === s.slice(6).toLowerCase().replace(/\\/g, '');
    if (s.startsWith('in.(')) return s.slice(4, -1).split(',').includes(row[k]);
    return true;
  });
  const get = jest.fn(async (t, params = {}) => db[t].filter(r => match(r, params)).slice(0, params.limit || 99));
  const post = jest.fn(async (t, row) => { db[t].push(row); return [row]; });
  const patch = jest.fn(async (t, params, fields) => { db[t].filter(r => match(r, params)).forEach(r => Object.assign(r, fields)); });
  const log = { log: jest.fn(), error: jest.fn() };
  return { svc: createIdentityService({ get, post, patch, getNegocios: () => NEGOCIOS, log }), get, post, patch, db, log };
}
const id = (o = {}) => ({ uid: 'uid-1', provider: 'google.com', email: 'ana@gmail.com', emailVerified: true, ...o });

describe('normalizePhone', () => {
  test.each([['999111222', '51999111222'], ['51999111222', '51999111222'], ['+51 999-111-222', '51999111222']])('%s', (i, o) => expect(normalizePhone(i)).toBe(o));
  test.each([[''], [null], ['123'], ['5199911122'], ['4155550100']])('rejects %p', i => expect(normalizePhone(i)).toBeNull());
});

describe('resolveSession', () => {
  test('verified email of a member creates a pending link and grants nothing', async () => {
    const b = build();
    const r = await b.svc.resolveSession(id());
    expect(r).toEqual({ status: 'pending' });
    expect(b.post).toHaveBeenCalledWith('firebase_identities', { firebase_uid: 'uid-1', profile_id: P_OWNER, provider: 'google.com', status: 'pending' });
    expect(JSON.stringify(b.log.log.mock.calls)).not.toContain('ana@gmail.com');
  });

  test('pending stays pending and does not create a second row', async () => {
    const b = build({ identities: [{ firebase_uid: 'uid-1', profile_id: P_OWNER, status: 'pending' }] });
    expect(await b.svc.resolveSession(id())).toEqual({ status: 'pending' });
    expect(b.post).not.toHaveBeenCalled();
  });

  test('active returns the businesses from farm_members', async () => {
    const b = build({ identities: [{ firebase_uid: 'uid-1', profile_id: P_OWNER, status: 'active' }] });
    expect(await b.svc.resolveSession(id())).toEqual({
      status: 'active',
      profile: { id: P_OWNER, fullName: 'Ana', hasPhone: false },
      businesses: [{ businessId: 'BIZ-002', name: 'Finca Rosal', address: 'Calle 1', city: 'Lima', role: 'owner' }],
    });
  });

  test('revoked is reported as revoked', async () => {
    const b = build({ identities: [{ firebase_uid: 'uid-1', profile_id: P_OWNER, status: 'revoked' }] });
    expect(await b.svc.resolveSession(id())).toEqual({ status: 'revoked' });
  });

  test.each([
    ['unverified email', { emailVerified: false }],
    ['no email (Apple hidden)', { email: null }],
    ['placeholder WhatsApp email', { email: '51999111222@whatsapp.apartalo.co' }],
    ['unknown email', { email: 'nobody@gmail.com' }],
    ['customer who is not a member', { email: 'dup@x.com' }],
    ['ambiguous email (two profiles)', { email: 'twin@x.com' }],
  ])('%s -> no_invitation and nothing is written', async (_l, over) => {
    const b = build();
    expect(await b.svc.resolveSession(id(over))).toEqual({ status: 'no_invitation' });
    expect(b.post).not.toHaveBeenCalled();
  });

  test('LIKE wildcards in the email cannot match other profiles', async () => {
    const b = build();
    await b.svc.resolveSession(id({ email: '%@gmail.com' }));
    expect(b.get).toHaveBeenCalledWith('profiles', expect.objectContaining({ email: 'ilike.\\%@gmail.com' }));
    expect(b.post).not.toHaveBeenCalled();
  });
});

describe('savePhone', () => {
  const active = [{ firebase_uid: 'uid-1', profile_id: P_OWNER, status: 'active' }];

  test('saves the canonical phone on an empty profile', async () => {
    const b = build({ identities: active });
    expect(await b.svc.savePhone(id(), '999 111 333')).toEqual({ saved: true });
    expect(b.db.profiles.find(p => p.id === P_OWNER).phone).toBe('51999111333');
  });

  test('requires an active link (pending and unknown are refused)', async () => {
    const pending = build({ identities: [{ firebase_uid: 'uid-1', profile_id: P_OWNER, status: 'pending' }] });
    expect((await pending.svc.savePhone(id(), '999111333')).reason).toBe('not-active');
    expect((await build().svc.savePhone(id(), '999111333')).reason).toBe('not-active');
    expect(pending.patch).not.toHaveBeenCalled();
  });

  test('never overwrites an existing phone, never takes one used by another profile', async () => {
    const set = build({ identities: active, profiles: [{ id: P_OWNER, email: 'a@b.c', phone: '51999000000' }] });
    expect((await set.svc.savePhone(id(), '999111333')).reason).toBe('already-set');
    const used = build({ identities: active });
    expect((await used.svc.savePhone(id(), '988000111')).reason).toBe('phone-in-use');
    expect(set.patch).not.toHaveBeenCalled(); expect(used.patch).not.toHaveBeenCalled();
  });

  test('invalid phone is refused before any query', async () => {
    const b = build({ identities: active });
    expect((await b.svc.savePhone(id(), 'abc')).reason).toBe('invalid-phone');
    expect(b.get).not.toHaveBeenCalled();
  });
});
