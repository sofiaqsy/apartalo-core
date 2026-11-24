const http = require('http');
const express = require('express');
const { createPublicProductsRouter, createIpLimit, clientIp } = require('../../routes/public-products-router');
const { createAuth } = require('../../core/middleware/auth');

const FARM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function start(router) {
  const app = express(); app.use('/api/public/farms', router);
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}
function get(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path, headers }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(out || '{}') }));
    }).on('error', reject);
  });
}
const pres = (o = {}) => ({ id: 'pp1', pack_size: 250, unit: 'g', price_cents: 2590, stock: 3, is_visible: true, image_url: 'https://img/1.jpg', b2b_price_cents: 1500, ...o });
const prod = (o = {}) => ({ id: 'p1', name: 'Blend', description: 'Rico', status: 'active', currency: 'PEN', green_lot_id: 'lot', totalSold: 99, pendingTueste: true, presentations: [pres()], ...o });

describe('public products router', () => {
  let server, allowed, t;
  const getApprovedFarm = jest.fn();
  const listProducts = jest.fn();
  const log = { error: jest.fn() };
  beforeAll(async () => { server = await start(createPublicProductsRouter({ getApprovedFarm, listProducts, log, allow: () => allowed, now: () => t })); });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => {
    jest.clearAllMocks(); allowed = true; t += 120000;
    getApprovedFarm.mockImplementation(async id => (id === FARM ? { id } : null));
    listProducts.mockResolvedValue([prod()]);
  });
  t = 0;

  test('an approved farm returns only the public fields', async () => {
    const r = await get(server, `/api/public/farms/${FARM}/products`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.body).toEqual({
      items: [{ id: 'p1', name: 'Blend', description: 'Rico', currency: 'PEN', photoUrl: 'https://img/1.jpg', available: true,
        presentations: [{ id: 'pp1', packSize: 250, unit: 'g', price: 25.9, available: true, photoUrl: 'https://img/1.jpg' }] }],
      total: 1, hasMore: false,
    });
    const raw = JSON.stringify(r.body);
    for (const secret of ['lot', 'totalSold', 'pendingTueste', '1500', 'stock']) expect(raw).not.toContain(secret);
  });

  test('a farm that is not approved (or does not exist) -> 404 and no products are read', async () => {
    expect((await get(server, `/api/public/farms/${OTHER}/products`)).status).toBe(404);
    expect(listProducts).not.toHaveBeenCalled();
  });

  test('not a uuid -> 404', async () => {
    expect((await get(server, '/api/public/farms/BIZ-002/products')).status).toBe(404);
    expect(getApprovedFarm).not.toHaveBeenCalled();
  });

  test('drafts, archived products and hidden presentations never appear', async () => {
    listProducts.mockResolvedValue([
      prod({ id: 'draft', status: 'draft' }), prod({ id: 'arch', status: 'archived' }),
      prod({ id: 'hidden', presentations: [pres({ is_visible: false })] }),
      prod({ id: 'mixed', name: 'Mixed', presentations: [pres({ id: 'v' }), pres({ id: 'h', is_visible: false })] }),
    ]);
    const r = await get(server, `/api/public/farms/${FARM}/products`);
    expect(r.body.items.map(x => x.id)).toEqual(['mixed']);
    expect(r.body.items[0].presentations.map(x => x.id)).toEqual(['v']);
  });

  test('no stock -> available false, still shown with its price', async () => {
    listProducts.mockResolvedValue([prod({ presentations: [pres({ stock: 0 })] })]);
    const r = await get(server, `/api/public/farms/${FARM}/products`);
    expect(r.body.items[0]).toMatchObject({ available: false, presentations: [{ available: false, price: 25.9 }] });
  });

  test('día and viaje do not use stock: available even with stock 0 (24 Nov 2026)', async () => {
    listProducts.mockResolvedValue([prod({ presentations: [
      pres({ id: 'd', unit: 'día', pack_size: 1, stock: 0 }),
      pres({ id: 'v', unit: 'Viaje', pack_size: 1, stock: 0 }),
      pres({ id: 'a', unit: 'dia', pack_size: 1, stock: 0 }),
      pres({ id: 'u', unit: 'unidad', pack_size: 1, stock: 0 }),
    ] })]);
    const r = await get(server, `/api/public/farms/${FARM}/products`);
    expect(r.body.items[0].presentations.map(x => [x.id, x.available])).toEqual([['d', true], ['v', true], ['a', true], ['u', false]]);
    expect(r.body.items[0].available).toBe(true);
  });

  test('long descriptions are cut', async () => {
    listProducts.mockResolvedValue([prod({ description: 'x'.repeat(1000) })]);
    const r = await get(server, `/api/public/farms/${FARM}/products`);
    expect(r.body.items[0].description.length).toBe(300);
  });

  test('pages of 20, limit at most 50', async () => {
    listProducts.mockResolvedValue(Array.from({ length: 60 }, (_, i) => prod({ id: `p${i}`, name: `P${String(i).padStart(2, '0')}` })));
    const a = await get(server, `/api/public/farms/${FARM}/products`);
    expect(a.body).toMatchObject({ total: 60, hasMore: true });
    expect(a.body.items).toHaveLength(20);
    const b = await get(server, `/api/public/farms/${FARM}/products?offset=40&limit=500`);
    expect(b.body.items).toHaveLength(20);
    expect(b.body.hasMore).toBe(false);
  });

  test('cached for 60 seconds, then read again', async () => {
    await get(server, `/api/public/farms/${FARM}/products`);
    await get(server, `/api/public/farms/${FARM}/products`);
    expect(listProducts).toHaveBeenCalledTimes(1);
    t += 61000;
    await get(server, `/api/public/farms/${FARM}/products`);
    expect(listProducts).toHaveBeenCalledTimes(2);
  });

  test('over the IP limit -> 429', async () => {
    allowed = false;
    expect((await get(server, `/api/public/farms/${FARM}/products`)).status).toBe(429);
  });

  test('database down -> 503', async () => {
    listProducts.mockRejectedValue(new Error('down'));
    expect((await get(server, `/api/public/farms/${FARM}/products`)).status).toBe(503);
  });
});

describe('helpers', () => {
  test('the client IP is the last X-Forwarded-For entry (a fake first entry is ignored)', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: {} })).toBe('1.2.3.4');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } })).toBe('9.9.9.9');
  });
  test('IP limit allows N per minute per IP', () => {
    let t = 0; const allow = createIpLimit({ perMinute: 2, now: () => t });
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    t = 60000; expect(allow('a')).toBe(true);
  });
  test('/public stays open even if login is enforced', async () => {
    const mw = createAuth({ mode: 'enforce', canEnforce: true, verifyToken: jest.fn(), log: { log() {}, warn() {}, error() {} } });
    const next = jest.fn();
    await mw({ path: '/public/farms/x/products', method: 'GET', headers: {} }, { status: () => ({ json() {} }) }, next);
    expect(next).toHaveBeenCalled();
  });
});
