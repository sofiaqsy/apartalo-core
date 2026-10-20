const http = require('http');
const express = require('express');
const { createAuthRouter } = require('../../routes/auth-router');

function start(router) {
  const app = express(); app.use(express.json()); app.use('/api/auth', router);
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}
function call(server, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ port: server.address().port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
}

describe('auth router', () => {
  let server; const service = { resolveSession: jest.fn(), savePhone: jest.fn() }; const verifyToken = jest.fn();
  beforeAll(async () => { server = await start(createAuthRouter({ service, verifyToken })); });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => { jest.clearAllMocks(); verifyToken.mockResolvedValue({ uid: 'u1' }); });

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
});
