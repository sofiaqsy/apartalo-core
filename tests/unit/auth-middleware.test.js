const { createAuth, resolveMode, routePattern, extractBearer } = require('../../core/middleware/auth');

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn(code => { res.statusCode = code; return res; });
  res.json = jest.fn(body => { res.body = body; return res; });
  return res;
}
function makeReq({ method = 'GET', path = '/pedidos/BIZ-002', headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, path, headers: lower, get: name => lower[String(name).toLowerCase()] };
}
const quietLog = () => ({ log: jest.fn(), error: jest.fn() });

describe('resolveMode', () => {
  test.each([
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['OBSERVE', 'observe'], ['  observe  ', 'observe'],
  ])('%p -> %s', (raw, expected) => expect(resolveMode(raw).mode).toBe(expected));

  test('enforce is downgraded to observe unless membership checks are wired', () => {
    const r = resolveMode('enforce', { canEnforce: false });
    expect(r.mode).toBe('observe');
    expect(r.warning).toMatch(/membres/i);
    expect(resolveMode('enforce', { canEnforce: true }).mode).toBe('enforce');
  });

  test('an unknown value never blocks and is visible (observe + warning)', () => {
    const r = resolveMode('enforced');
    expect(r.mode).toBe('observe');
    expect(r.warning).toBeTruthy();
  });
});

describe('routePattern', () => {
  test('replaces identifiers so logs carry no ids', () => {
    const p = routePattern('/pedidos/BIZ-002/ORD-20260918-d3394f0b/evidencias/3f2c8a1e-1111-4222-8333-444455556666?x=1');
    expect(p).toBe('/pedidos/:biz/:order/evidencias/:uuid');
    expect(p).not.toMatch(/d3394f0b|3f2c8a1e|BIZ-002/);
  });
  test('numeric ids', () => expect(routePattern('/clientes/BIZ-002/51944494966')).toBe('/clientes/:biz/:num'));
});

describe('extractBearer', () => {
  test.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'], ['bearer abc', 'abc'],
    ['Basic abc', null], ['Bearer', null], ['Bearer a b', null], [undefined, null],
  ])('%p -> %p', (header, expected) => {
    expect(extractBearer({ headers: header === undefined ? {} : { authorization: header } })).toBe(expected);
  });
});

describe('mode: off (default)', () => {
  test('does nothing: no logs, no req.auth, next is called', async () => {
    const log = quietLog();
    const mw = createAuth({ mode: undefined, verifyToken: jest.fn(), log });
    const req = makeReq(); const next = jest.fn();
    await mw(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toBeUndefined();
    expect(log.log).not.toHaveBeenCalled();
    expect(mw.mode).toBe('off');
  });
});

describe('mode: observe', () => {
  test('never blocks and logs client, user-agent family and token presence', async () => {
    const log = quietLog();
    const mw = createAuth({ mode: 'observe', verifyToken: jest.fn(), log });
    const next = jest.fn();
    await mw(makeReq({ headers: { 'X-Client': 'apartalo-app', 'User-Agent': 'Dart/3.4 (dart:io)' } }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    const line = log.log.mock.calls[0][0];
    expect(line).toContain('[AUTH-OBSERVE]');
    expect(line).toContain('client=apartalo-app');
    expect(line).toContain('ua=Dart');
    expect(line).toContain('token=no');
  });

  test('legacy clients (no X-Client) are labelled, and a token is reported only as presence', async () => {
    const log = quietLog();
    const mw = createAuth({ mode: 'observe', verifyToken: jest.fn(), log });
    await mw(makeReq({ headers: { Authorization: 'Bearer SECRET-TOKEN-VALUE-123' } }), makeRes(), jest.fn());
    const line = log.log.mock.calls[0][0];
    expect(line).toContain('client=legacy');
    expect(line).toContain('token=yes');
    expect(JSON.stringify(log.log.mock.calls)).not.toContain('SECRET-TOKEN-VALUE-123');
  });

  test('does not verify tokens in observe (no cost, no side effects)', async () => {
    const verify = jest.fn();
    const mw = createAuth({ mode: 'observe', verifyToken: verify, log: quietLog() });
    await mw(makeReq({ headers: { Authorization: 'Bearer abc' } }), makeRes(), jest.fn());
    expect(verify).not.toHaveBeenCalled();
  });

  test('the public tracking page is exempt and not logged', async () => {
    const log = quietLog();
    const mw = createAuth({ mode: 'observe', verifyToken: jest.fn(), log });
    const req = makeReq({ path: '/track/BIZ-002/ORD-1' }); const next = jest.fn();
    await mw(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.auth).toEqual({ exempt: true });
    expect(log.log).not.toHaveBeenCalled();
  });
});

describe('enforce safety', () => {
  test('cannot be activated without membership checks: behaves as observe and says so', async () => {
    const log = quietLog();
    const verify = jest.fn();
    const mw = createAuth({ mode: 'enforce', canEnforce: false, verifyToken: verify, log });
    const res = makeRes(); const next = jest.fn();
    await mw(makeReq(), res, next);                     // no token at all
    expect(mw.mode).toBe('observe');
    expect(next).toHaveBeenCalled();                    // not blocked
    expect(res.status).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('AUTH_MODE=enforce'));
  });
});

describe('mode: enforce (when membership checks exist)', () => {
  const make = (verify) => createAuth({ mode: 'enforce', canEnforce: true, verifyToken: verify, log: quietLog() });

  test('no token -> 401, next not called', async () => {
    const res = makeRes(); const next = jest.fn();
    await make(jest.fn())(makeReq(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('invalid or expired token -> 401', async () => {
    const res = makeRes(); const next = jest.fn();
    await make(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'auth/id-token-expired' })))(
      makeReq({ headers: { Authorization: 'Bearer abc' } }), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('Firebase not initialised -> 503 (fails closed, never allows)', async () => {
    const res = makeRes(); const next = jest.fn();
    await make(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'auth/not-initialized' })))(
      makeReq({ headers: { Authorization: 'Bearer abc' } }), res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('valid token -> req.auth carries only uid and provider', async () => {
    const req = makeReq({ headers: { Authorization: 'Bearer abc' } }); const next = jest.fn();
    await make(jest.fn().mockResolvedValue({ uid: 'u1', provider: 'apple.com', email: 'secret@x.com' }))(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.auth).toEqual({ uid: 'u1', provider: 'apple.com' });
  });

  test('exempt routes stay open even in enforce', async () => {
    const next = jest.fn(); const res = makeRes();
    await make(jest.fn())(makeReq({ path: '/track/BIZ-002/ORD-1' }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
