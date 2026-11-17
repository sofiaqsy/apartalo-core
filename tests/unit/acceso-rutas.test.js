// Phase 1 of closing the routes that worked without a login (17 Nov 2026): the real routers, mounted in the same order
// as app.js, with the database answering who is who.
jest.mock('../../core/services/supabase-service');
jest.mock('../../config/negocios', () => ({
  getById: id => (id === 'BIZ-002' ? { id, farmId: 'farm-rosal', whatsapp: {} } : null),
  getAll: () => [], reload: async () => {},
}));
jest.mock('../../core/services/whatsapp-service', () => jest.fn().mockImplementation(() => ({ sendMessage: async () => ({ messages: [{ id: 'm1' }] }) })));
jest.mock('../../core/services/sheets-service', () => jest.fn());
jest.mock('../../core/services/supabase-sheets-adapter', () => jest.fn());
jest.mock('../../core/services/firebase-service', () => ({ verifyIdToken: async () => { throw new Error('x'); }, initialized: false }));
jest.mock('../../core/services/ownership-instance', () => {
  const pasa = (q, s, n) => n();
  return { guards: new Proxy({}, { get: () => pasa }) };
});
jest.mock('tesseract.js', () => ({ createWorker: async () => ({ recognize: async () => ({ data: { text: '' } }), terminate: async () => {} }) }));
const http = require('http');
const express = require('express');

function call(server, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port: server.address().port, path, method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, res => { let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('routes closed without a login (phase 1)', () => {
  let server;
  const EVENTO = '11111111-2222-3333-4444-555555555555';
  beforeAll(done => {
    // "miembro" belongs to Finca Rosal; "otro" is signed in but belongs to no business here.
    global.fetch = jest.fn(async (url, opts) => {
      const fn = String(url).split('/rpc/')[1];
      const token = opts.headers.Authorization.replace('Bearer ', '');
      const miembro = token === 'miembro';
      const data = {
        farm_customer_access: { miembro, ve_todos: miembro },
        me_profile_ids: ['p-' + token],
        profile_in_my_farms: miembro,
        roast_event_member: miembro,
      }[fn];
      return { ok: true, status: 200, text: async () => JSON.stringify(data === undefined ? null : data) };
    });
    const app = express();
    app.use(express.json());
    app.use('/api/bot', require('../../routes/bot-conversations-router'));
    app.use('/api/ocr', require('../../routes/ocr-router'));
    app.use('/api/upload', require('../../routes/upload-router'));
    app.use('/api/delivery', require('../../routes/delivery-router'));
    app.use('/api', require('../../routes/api-router'));
    app.get('/api/track/:b/:p', (req, res) => res.json({ ok: true })); // mounted after the general router, public
    app.use('/api/tostador', require('../../routes/tostador-router'));
    server = app.listen(0, done);
  });
  afterAll(() => new Promise(res => server.close(res)));

  test('deleting or uploading a stored file needs a member', async () => {
    expect((await call(server, 'DELETE', '/api/upload/BIZ-002/payment-proofs/x.jpg')).status).toBe(401);
    expect((await call(server, 'DELETE', '/api/upload/BIZ-002/payment-proofs/x.jpg', { token: 'otro' })).status).toBe(403);
    expect((await call(server, 'POST', '/api/upload/BIZ-002', { body: {} })).status).toBe(401);
  });

  test('sending WhatsApp as the business needs a member of that business', async () => {
    const body = { businessId: 'BIZ-002', to: '51999000000', message: 'hola' };
    expect((await call(server, 'POST', '/api/mensaje', { body })).status).toBe(401);
    expect((await call(server, 'POST', '/api/mensaje', { token: 'otro', body })).status).toBe(403);
    expect((await call(server, 'POST', '/api/mensaje', { token: 'miembro', body })).status).toBe(200);
  });

  test('changing products needs a member; the catalog stays public', async () => {
    expect((await call(server, 'PUT', '/api/productos/BIZ-002/CAF-1', { body: { precio: 1 } })).status).toBe(401);
    expect((await call(server, 'POST', '/api/productos/BIZ-002/CAF-1/stock', { body: {} })).status).toBe(401);
    expect((await call(server, 'GET', '/api/productos/BIZ-002')).status).not.toBe(401);
    expect((await call(server, 'GET', '/api/negocios')).status).toBe(200);
  });

  test('conversations, deliveries and client prices need a member', async () => {
    expect((await call(server, 'GET', '/api/conversaciones/BIZ-002')).status).toBe(401);
    expect((await call(server, 'GET', '/api/bot/conversaciones/BIZ-002')).status).toBe(401);
    expect((await call(server, 'GET', '/api/delivery/BIZ-002')).status).toBe(401);
    expect((await call(server, 'GET', '/api/precios-cliente/BIZ-002/c1')).status).toBe(401);
    expect((await call(server, 'GET', '/api/recetas/BIZ-002')).status).toBe(401);
  });

  test('the photo reader needs a login and only reads our storage', async () => {
    expect((await call(server, 'GET', '/api/ocr/image?url=https://example.com/a.jpg')).status).toBe(401);
    expect((await call(server, 'GET', '/api/ocr/image?url=https://example.com/a.jpg', { token: 'miembro' })).status).toBe(400);
  });

  test('roasting: a login, roasters and events of my businesses', async () => {
    expect((await call(server, 'GET', '/api/tostador/events?profileId=p1')).status).toBe(401);
    expect((await call(server, 'GET', '/api/tostador/events?profileId=p1', { token: 'otro' })).status).toBe(403);
    expect((await call(server, 'POST', `/api/tostador/events/${EVENTO}/start-admin`, { token: 'otro', body: {} })).status).toBe(404);
    expect((await call(server, 'GET', '/api/tostador/green-lots?businessId=BIZ-002', { token: 'otro' })).status).toBe(403);
  });

  test('tracking, mounted after the general router, stays public', async () => {
    expect((await call(server, 'GET', '/api/track/BIZ-002/ORD-1')).status).toBe(200);
  });
});
