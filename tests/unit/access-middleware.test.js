const { createAccess, roleRank } = require('../../core/middleware/access');

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn(code => { res.statusCode = code; return res; });
  res.json = jest.fn(body => { res.body = body; return res; });
  return res;
}
const quietLog = () => ({ log: jest.fn(), error: jest.fn() });
const req = (extra = {}) => ({ method: 'GET', params: { businessId: 'BIZ-002' }, baseUrl: '/api/pedidos', route: { path: '/:businessId' }, ...extra });
const negocios = { 'BIZ-002': { farmId: 'farm-A' } };
const getNegocio = id => negocios[id] || null;

describe('roleRank', () => {
  test('orders roles and gives unknown roles no access', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('staff'));
    expect(roleRank('staff')).toBeGreaterThan(roleRank('roaster'));
    expect(roleRank('admin')).toBe(0);
    expect(roleRank(null)).toBe(0);
  });
});

describe('requireBusinessAccess', () => {
  test('mode off: passes without any lookup', async () => {
    const getRole = jest.fn();
    const mw = createAccess({ mode: 'off', getNegocio, getRole, log: quietLog() })('owner');
    const next = jest.fn();
    await mw(req(), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(getRole).not.toHaveBeenCalled();
  });

  describe('enforce', () => {
    const make = (getRole, min = 'staff') => createAccess({ mode: 'enforce', getNegocio, getRole, log: quietLog() })(min);

    test('unknown business -> 404', async () => {
      const res = makeRes(); const next = jest.fn();
      await make(jest.fn())(req({ params: { businessId: 'BIZ-999' }, auth: { uid: 'u' } }), res, next);
      expect(res.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
    });

    test('no authenticated user -> 401', async () => {
      const res = makeRes(); const next = jest.fn();
      await make(jest.fn())(req(), res, next);
      expect(res.statusCode).toBe(401); expect(next).not.toHaveBeenCalled();
    });

    test('not a member -> 403', async () => {
      const res = makeRes(); const next = jest.fn();
      await make(jest.fn().mockResolvedValue(null))(req({ auth: { uid: 'u' } }), res, next);
      expect(res.statusCode).toBe(403); expect(next).not.toHaveBeenCalled();
    });

    test('role too low -> 403', async () => {
      const res = makeRes(); const next = jest.fn();
      await make(jest.fn().mockResolvedValue('roaster'), 'staff')(req({ auth: { uid: 'u' } }), res, next);
      expect(res.statusCode).toBe(403); expect(next).not.toHaveBeenCalled();
    });

    test('enough role -> next; lookup uses the business farm, not anything from the client', async () => {
      const getRole = jest.fn().mockResolvedValue('owner'); const next = jest.fn();
      await make(getRole, 'staff')(req({ auth: { uid: 'u1' } }), makeRes(), next);
      expect(next).toHaveBeenCalled();
      expect(getRole).toHaveBeenCalledWith('u1', 'farm-A');
    });

    test('lookup failure -> 503 (fail closed)', async () => {
      const res = makeRes(); const next = jest.fn();
      await make(jest.fn().mockRejectedValue(new Error('db down')))(req({ auth: { uid: 'u' } }), res, next);
      expect(res.statusCode).toBe(503); expect(next).not.toHaveBeenCalled();
    });

    test('route without a business in the path is not this middleware\'s concern', async () => {
      const next = jest.fn();
      await make(jest.fn())(req({ params: {} }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('observe', () => {
    test('never blocks, logs would-deny without ids', async () => {
      const log = quietLog();
      const mw = createAccess({ mode: 'observe', getNegocio, getRole: jest.fn().mockResolvedValue(null), log })('staff');
      const res = makeRes(); const next = jest.fn();
      await mw(req({ auth: { uid: 'secret-uid' } }), res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      const line = log.log.mock.calls[0][0];
      expect(line).toContain('would-deny reason=not-a-member');
      expect(line).not.toContain('secret-uid');
      expect(line).not.toContain('BIZ-002');
    });

    test('our own lookup error does not block', async () => {
      const mw = createAccess({ mode: 'observe', getNegocio, getRole: jest.fn().mockRejectedValue(new Error('x')), log: quietLog() })('staff');
      const next = jest.fn();
      await mw(req({ auth: { uid: 'u' } }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
  });

  test('invalid mode falls back to observe (never blocks)', async () => {
    const log = quietLog();
    const mw = createAccess({ mode: 'bogus', getNegocio, getRole: jest.fn().mockResolvedValue(null), log })('staff');
    const next = jest.fn();
    await mw(req({ auth: { uid: 'u' } }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});
