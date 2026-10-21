const http = require('http');
const express = require('express');
const { createAuthRouter } = require('../../routes/auth-router');
const { JoinError } = require('../../core/services/join-service');

function start(router) {
  const app = express(); app.use(express.json()); app.use('/api/auth', router);
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}
function call(server, path, { token, body, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ port: server.address().port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
}

describe('auth router', () => {
  let server; const service = { resolveSession: jest.fn(), savePhone: jest.fn() };
  const join = { pendingFor: jest.fn(), submit: jest.fn(), createCode: jest.fn(), listRequests: jest.fn(), decide: jest.fn() }; const verifyToken = jest.fn();
  beforeAll(async () => { server = await start(createAuthRouter({ service, join, verifyToken })); });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => { jest.clearAllMocks(); verifyToken.mockResolvedValue({ uid: 'u1' }); join.pendingFor.mockResolvedValue([]); });

  test('no token -> 401, service untouched', async () => {
    expect((await call(server, '/api/auth/session')).status).toBe(401);
    expect(service.resolveSession).not.toHaveBeenCalled();
  });
  test('bad token -> 401', async () => {
    verifyToken.mockRejectedValue(Object.assign(new Error('x'), { code: 'auth/id-token-expired' }));
    expect((await call(server, '/api/auth/session', { token: 'abc' })).status).toBe(401);
  });
  test('Firebase down -> 503', async () => {
    verifyToken.mockRejectedValue(Object.assign(new Error('x'), { code: 'auth/not-initialized' }));
    expect((await call(server, '/api/auth/session', { token: 'abc' })).status).toBe(503);
  });
  test('session passes the verified identity, never the body', async () => {
    service.resolveSession.mockResolvedValue({ status: 'pending' });
    const r = await call(server, '/api/auth/session', { token: 'abc', body: { uid: 'attacker' } });
    expect(r).toEqual({ status: 200, body: { status: 'pending' } });
    expect(service.resolveSession).toHaveBeenCalledWith({ uid: 'u1' });
  });
  test('phone: saved 200, refused 400, already-set 200', async () => {
    service.savePhone.mockResolvedValueOnce({ saved: true }).mockResolvedValueOnce({ saved: false, reason: 'not-active' }).mockResolvedValueOnce({ saved: false, reason: 'already-set' });
    expect((await call(server, '/api/auth/phone', { token: 'a', body: { phone: '1' } })).status).toBe(200);
    expect((await call(server, '/api/auth/phone', { token: 'a', body: { phone: '1' } })).status).toBe(400);
    expect((await call(server, '/api/auth/phone', { token: 'a', body: { phone: '1' } })).status).toBe(200);
    expect(service.savePhone).toHaveBeenCalledWith({ uid: 'u1' }, '1');
  });
  test('service error -> 500 without details', async () => {
    service.resolveSession.mockRejectedValue(new Error('db password leaked'));
    const r = await call(server, '/api/auth/session', { token: 'abc' });
    expect(r.status).toBe(500); expect(JSON.stringify(r.body)).not.toContain('leaked');
  });

  test('no_invitation with an open join request becomes join_pending', async () => {
    service.resolveSession.mockResolvedValue({ status: 'no_invitation' });
    join.pendingFor.mockResolvedValue([{ businessName: 'Finca A' }]);
    expect((await call(server, '/api/auth/session', { token: 'a' })).body).toEqual({ status: 'join_pending', businessName: 'Finca A' });
  });
  test('join endpoints require a token', async () => {
    for (const path of ['/api/auth/join', '/api/auth/join-codes', '/api/auth/join-requests/x/decision']) {
      expect((await call(server, path)).status).toBe(401);
    }
    expect((await call(server, '/api/auth/join-requests?businessId=B', { method: 'GET' })).status).toBe(401);
  });
  test('join: passes verified identity and code; JoinError keeps its status, other errors are 500 without details', async () => {
    join.submit.mockResolvedValueOnce({ status: 'join_pending' });
    expect((await call(server, '/api/auth/join', { token: 'a', body: { code: 'ABCD-EFGH', uid: 'attacker' } })).status).toBe(200);
    expect(join.submit).toHaveBeenCalledWith({ uid: 'u1' }, 'ABCD-EFGH');
    join.submit.mockRejectedValueOnce(new JoinError(400, 'invalid-code', 'Código no válido o vencido'));
    expect(await call(server, '/api/auth/join', { token: 'a', body: { code: 'x' } })).toEqual({ status: 400, body: { error: 'Código no válido o vencido', code: 'invalid-code' } });
    join.submit.mockRejectedValueOnce(new Error('secret db detail'));
    const r = await call(server, '/api/auth/join', { token: 'a', body: { code: 'x' } });
    expect(r.status).toBe(500); expect(JSON.stringify(r.body)).not.toContain('secret');
  });
  test('decision: approve only when exactly true', async () => {
    join.decide.mockResolvedValue({ status: 'rejected' });
    await call(server, '/api/auth/join-requests/r1/decision', { token: 'a', body: { businessId: 'BIZ-A', approve: 'true' } });
    expect(join.decide).toHaveBeenCalledWith({ uid: 'u1' }, 'BIZ-A', 'r1', false);
  });
});
