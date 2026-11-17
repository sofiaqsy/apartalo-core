// Pedidos only for members; a seller only his clients' pedidos (17 Nov 2026).
jest.mock('../../core/services/supabase-service');
jest.mock('../../config/negocios', () => ({ getById: id => (id === 'BIZ-002' ? { farmId: 'farm-rosal' } : null) }));
jest.mock('../../core/services/whatsapp-service', () => ({}));
jest.mock('../../core/services/firebase-service', () => ({ verifyIdToken: async () => { throw new Error('x'); } }));
jest.mock('../../core/services/ownership-instance', () => ({ guards: { order: (q, s, n) => n(), orderEvidence: (q, s, n) => n() } }));
const http = require('http');
const express = require('express');
const supabaseService = require('../../core/services/supabase-service');
const router = require('../../routes/pedidos-router');

function get(server, path, token) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    }).on('error', reject);
  });
}

describe('Pedidos access', () => {
  let server;
  beforeAll(done => {
    // The database: "vendedor" is a member who does not see all, with one pedido; "dueno" sees all; "otro" is not a member.
    global.fetch = jest.fn(async (url, opts) => {
      const fn = String(url).split('/rpc/')[1];
      const token = opts.headers.Authorization.replace('Bearer ', '');
      const body = JSON.parse(opts.body);
      let data = null;
      if (fn === 'farm_customer_access') data = { miembro: token !== 'otro', ve_todos: token === 'dueno' };
      if (fn === 'farm_seller_order_ids') data = ['o-suyo'];
      if (fn === 'farm_order_visible') data = body.p_order_ref === 'ORD-SUYO';
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    });
    supabaseService.getOrdersByFarm.mockImplementation(async (farm, f) => ({ total: f.ids ? f.ids.length : 99, pedidos: [], filtro: f.ids || null }));
    supabaseService.getOrderByIdOrNumber.mockResolvedValue({ id: 'ORD-SUYO', supabaseId: 'o-suyo' });
    supabaseService.post.mockResolvedValue(null);
    const app = express();
    app.use('/api/pedidos', router);
    server = app.listen(0, done);
  });
  afterAll(() => new Promise(res => server.close(res)));

  test('without a login, nothing', async () => {
    expect((await get(server, '/api/pedidos/BIZ-002')).status).toBe(401);
    expect((await get(server, '/api/pedidos/BIZ-002/ORD-SUYO')).status).toBe(401);
  });

  test('a person of another business: 403; asking as B2B gives an empty list, never the pedidos', async () => {
    expect((await get(server, '/api/pedidos/BIZ-002', 'otro')).status).toBe(403);
    const b2b = await get(server, '/api/pedidos/BIZ-002?tipo=B2B&negocioSolicitante=BIZ-OTRO', 'otro');
    expect(b2b.status).toBe(200);
    expect(b2b.body).toEqual({ total: 0, pedidos: [], pagina: 1, totalPaginas: 0, hayMas: false });
  });

  test('the owner sees all; a seller only his', async () => {
    expect((await get(server, '/api/pedidos/BIZ-002', 'dueno')).body.filtro).toBeNull();
    expect((await get(server, '/api/pedidos/BIZ-002', 'vendedor')).body.filtro).toEqual(['o-suyo']);
  });

  test('a seller opens his pedido, not another one', async () => {
    expect((await get(server, '/api/pedidos/BIZ-002/ORD-SUYO', 'vendedor')).status).toBe(200);
    expect((await get(server, '/api/pedidos/BIZ-002/ORD-OTRO', 'vendedor')).status).toBe(404);
  });
});
