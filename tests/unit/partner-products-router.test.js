const http = require('http');
const express = require('express');
const { createPartnerProductsRouter, createIdempotency, createRateLimit } = require('../../routes/partner-products-router');

const FARM_A = '11111111-1111-4111-8111-111111111111';
const FARM_B = '22222222-2222-4222-8222-222222222222';
const PROD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRES_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRES_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function start(router) {
  const app = express(); app.use(express.json()); app.use('/api/v1/farms', router);
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}
function call(server, path, { token = 'tok', body, method = 'GET', key } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const req = http.request({ port: server.address().port, path, method, headers }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
}

const product = (id, farm, extra = {}) => ({ id, farm_id: farm, name: 'Blend', description: '', status: 'active', currency: 'PEN', ...extra });

describe('partner products router', () => {
  let server, allowed;
  const verifyToken = jest.fn();
  const resolveSession = jest.fn();
  const products = {
    list: jest.fn(), getById: jest.fn(), create: jest.fn(), update: jest.fn(),
    getPresentation: jest.fn(), createPresentation: jest.fn(), updatePresentation: jest.fn(),
  };
  const photos = { prepareUpload: jest.fn(), register: jest.fn(), remove: jest.fn() };
  const log = { log: jest.fn(), error: jest.fn() };

  beforeAll(async () => {
    server = await start(createPartnerProductsRouter({ verifyToken, resolveSession, products, photos, log, allow: () => allowed }));
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => {
    jest.clearAllMocks();
    allowed = true;
    verifyToken.mockResolvedValue({ uid: 'u1' });
    resolveSession.mockResolvedValue({ status: 'active', businesses: [{ businessId: 'BIZ-A', farmId: FARM_A, role: 'owner' }] });
    products.getById.mockImplementation(async id => ({ [PROD_A]: product(PROD_A, FARM_A), [PROD_B]: product(PROD_B, FARM_B) }[id] || null));
    products.getPresentation.mockImplementation(async id => ({ [PRES_A]: { id: PRES_A, product_id: PROD_A, pack_size: 250, unit: 'g', price_cents: 2500, stock: 3, is_visible: true },
      [PRES_B]: { id: PRES_B, product_id: PROD_B } }[id] || null));
  });

  describe('access', () => {
    test('no token -> 401 and nothing is read', async () => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products`, { token: null });
      expect(r.status).toBe(401);
      expect(products.list).not.toHaveBeenCalled();
    });

    test('invalid token -> 401', async () => {
      verifyToken.mockRejectedValue(new Error('bad'));
      expect((await call(server, `/api/v1/farms/${FARM_A}/products`)).status).toBe(401);
    });

    test('signed in but not a member -> 403', async () => {
      resolveSession.mockResolvedValue({ status: 'no_invitation' });
      expect((await call(server, `/api/v1/farms/${FARM_A}/products`)).status).toBe(403);
    });

    test('pending link -> 403', async () => {
      resolveSession.mockResolvedValue({ status: 'pending' });
      expect((await call(server, `/api/v1/farms/${FARM_A}/products`)).status).toBe(403);
    });

    test('member of farm A cannot read or write farm B', async () => {
      expect((await call(server, `/api/v1/farms/${FARM_B}/products`)).status).toBe(403);
      const w = await call(server, `/api/v1/farms/${FARM_B}/products`, { method: 'POST', key: 'key-12345678', body: { name: 'X' } });
      expect(w.status).toBe(403);
      expect(products.create).not.toHaveBeenCalled();
    });

    test('a product of farm B through farm A -> 404 and nothing changes', async () => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_B}`, { method: 'PATCH', body: { name: 'Hack' } });
      expect(r.status).toBe(404);
      expect(products.update).not.toHaveBeenCalled();
    });

    test('a presentation of another product -> 404', async () => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_B}`, { method: 'PATCH', body: { price: 1 } });
      expect(r.status).toBe(404);
      expect(products.updatePresentation).not.toHaveBeenCalled();
    });

    test('staff can work too', async () => {
      resolveSession.mockResolvedValue({ status: 'active', businesses: [{ farmId: FARM_A, role: 'staff' }] });
      products.list.mockResolvedValue([]);
      expect((await call(server, `/api/v1/farms/${FARM_A}/products`)).status).toBe(200);
    });

    test('not a uuid farm -> 404 without asking the session', async () => {
      expect((await call(server, '/api/v1/farms/BIZ-002/products')).status).toBe(404);
      expect(resolveSession).not.toHaveBeenCalled();
    });

    test('over the per-minute limit -> 429', async () => {
      allowed = false;
      expect((await call(server, `/api/v1/farms/${FARM_A}/products`)).status).toBe(429);
    });

    test('session check failing -> 503, never a pass', async () => {
      resolveSession.mockRejectedValue(new Error('db down'));
      expect((await call(server, `/api/v1/farms/${FARM_A}/products`)).status).toBe(503);
    });
  });

  describe('products', () => {
    test('list pages of 20 with the same rows as Apartalo', async () => {
      products.list.mockResolvedValue(Array.from({ length: 25 }, (_, i) => ({
        id: `p${i}`, name: `P${i}`, status: 'active', presentations: [{ id: 'x', pack_size: 250, unit: 'g', price_cents: 2550, stock: 2, is_visible: true }],
      })));
      const r = await call(server, `/api/v1/farms/${FARM_A}/products`);
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(20);
      expect(r.body).toMatchObject({ total: 25, hasMore: true });
      expect(r.body.items[0].presentations[0]).toEqual({ id: 'x', packSize: 250, unit: 'g', price: 25.5, stock: 2, visible: true, isDefault: false, photos: [] });
      expect(products.list).toHaveBeenCalledWith(FARM_A);
      const r2 = await call(server, `/api/v1/farms/${FARM_A}/products?offset=20`);
      expect(r2.body).toMatchObject({ total: 25, hasMore: false });
      expect(r2.body.items).toHaveLength(5);
    });

    test('create needs an Idempotency-Key', async () => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products`, { method: 'POST', body: { name: 'Blend' } });
      expect(r.status).toBe(400);
      expect(products.create).not.toHaveBeenCalled();
    });

    test('create starts as draft; the same key twice creates one product', async () => {
      products.create.mockResolvedValue({ id: PROD_A, name: 'Blend', status: 'draft', currency: 'PEN' });
      const a = await call(server, `/api/v1/farms/${FARM_A}/products`, { method: 'POST', key: 'retry-0001', body: { name: ' Blend ' } });
      const b = await call(server, `/api/v1/farms/${FARM_A}/products`, { method: 'POST', key: 'retry-0001', body: { name: ' Blend ' } });
      expect(a.status).toBe(201);
      expect(b).toEqual(a);
      expect(products.create).toHaveBeenCalledTimes(1);
      expect(products.create).toHaveBeenCalledWith(FARM_A, { name: 'Blend', description: undefined, status: 'draft' });
    });

    test('create without name -> 400 with the field', async () => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products`, { method: 'POST', key: 'retry-0002', body: { name: '  ' } });
      expect(r).toEqual({ status: 400, body: { error: 'Missing field: name', field: 'name' } });
    });

    test('create with an unknown status -> 400', async () => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products`, { method: 'POST', key: 'retry-0003', body: { name: 'A', status: 'deleted' } });
      expect(r.status).toBe(400);
    });

    test('edit name and archive (nothing is deleted)', async () => {
      products.update.mockResolvedValue(product(PROD_A, FARM_A, { name: 'Blend Omagua', status: 'archived' }));
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}`, { method: 'PATCH', body: { name: 'Blend Omagua', status: 'archived' } });
      expect(r.status).toBe(200);
      expect(products.update).toHaveBeenCalledWith(PROD_A, { name: 'Blend Omagua', status: 'archived' });
      expect(r.body).toMatchObject({ id: PROD_A, name: 'Blend Omagua', status: 'archived' });
    });

    test('edit with nothing to change -> 400', async () => {
      expect((await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}`, { method: 'PATCH', body: {} })).status).toBe(400);
    });
  });

  describe('presentations and photos', () => {
    test('create a presentation: price in soles is stored in cents', async () => {
      products.createPresentation.mockResolvedValue({ id: PRES_A, product_id: PROD_A, pack_size: 250, unit: 'g', price_cents: 2590, stock: 4, is_visible: true });
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations`, { method: 'POST', key: 'pres-0001', body: { packSize: 250, unit: 'g', price: 25.9, stock: 4 } });
      expect(r.status).toBe(201);
      expect(products.createPresentation).toHaveBeenCalledWith(PROD_A, { packSize: 250, unit: 'g', priceCents: 2590, stock: 4, isVisible: true });
      expect(r.body.price).toBe(25.9);
    });

    test.each([
      [{ unit: 'g', price: 10 }, 'packSize'],
      [{ packSize: 250, price: 10 }, 'unit'],
      [{ packSize: 250, unit: 'g' }, 'price'],
      [{ packSize: 250, unit: 'g', price: -1 }, 'price'],
      [{ packSize: 250, unit: 'g', price: 10, stock: 1.5 }, 'stock'],
    ])('bad presentation %p -> 400 on %s', async (body, field) => {
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations`, { method: 'POST', key: `bad-${field}-0001`, body });
      expect(r.status).toBe(400);
      expect(r.body.field).toBe(field);
      expect(products.createPresentation).not.toHaveBeenCalled();
    });

    test('change price, stock and hide a presentation', async () => {
      products.updatePresentation.mockResolvedValue({ id: PRES_A, product_id: PROD_A, pack_size: 250, unit: 'g', price_cents: 3000, stock: 0, is_visible: false });
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}`, { method: 'PATCH', body: { price: 30, stock: 0, visible: false } });
      expect(r.status).toBe(200);
      expect(products.updatePresentation).toHaveBeenCalledWith(PRES_A, { price_cents: 3000, stock: 0, is_visible: false });
      expect(r.body).toMatchObject({ price: 30, stock: 0, visible: false });
    });

    test('photo upload: sign then register, inside the product', async () => {
      photos.prepareUpload.mockResolvedValue({ signedUrl: 'https://s/x', path: `products/${PROD_A}/gallery-1-a.jpg` });
      photos.register.mockResolvedValue({ id: 'm1', url: 'https://s/p.jpg', orden: 0 });
      const s = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}/photos/sign`, { method: 'POST', body: { mimeType: 'image/jpeg' } });
      expect(s.status).toBe(200);
      expect(photos.prepareUpload).toHaveBeenCalledWith(PROD_A, PRES_A, 'image/jpeg');
      const g = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}/photos`, { method: 'POST', key: 'photo-0001', body: { path: s.body.path, mimeType: 'image/jpeg' } });
      expect(g).toEqual({ status: 201, body: { id: 'm1', url: 'https://s/p.jpg' } });
    });

    test('remove a wrong photo of the presentation', async () => {
      photos.remove.mockResolvedValue();
      const PHOTO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}/photos/${PHOTO}`, { method: 'DELETE' });
      expect(r).toEqual({ status: 200, body: { removed: true } });
      expect(photos.remove).toHaveBeenCalledWith(PROD_A, PRES_A, PHOTO);
    });

    test('remove a photo: another farm, product or presentation never reaches the photos', async () => {
      const PHOTO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      expect((await call(server, `/api/v1/farms/${FARM_B}/products/${PROD_B}/presentations/${PRES_B}/photos/${PHOTO}`, { method: 'DELETE' })).status).toBe(403);
      expect((await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_B}/presentations/${PRES_B}/photos/${PHOTO}`, { method: 'DELETE' })).status).toBe(404);
      expect((await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_B}/photos/${PHOTO}`, { method: 'DELETE' })).status).toBe(404);
      expect((await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}/photos/${PHOTO}`, { method: 'DELETE', token: null })).status).toBe(401);
      expect(photos.remove).not.toHaveBeenCalled();
    });

    test('a photo that is not of this presentation answers 404', async () => {
      const err = new Error('Foto no encontrada'); err.status = 404;
      photos.remove.mockRejectedValue(err);
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}/photos/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`, { method: 'DELETE' });
      expect(r.status).toBe(404);
    });

    test('a photo error keeps its status (for example the 3-photo limit)', async () => {
      const err = new Error('Máximo 3 fotos por presentación'); err.status = 409;
      photos.prepareUpload.mockRejectedValue(err);
      const r = await call(server, `/api/v1/farms/${FARM_A}/products/${PROD_A}/presentations/${PRES_A}/photos/sign`, { method: 'POST', body: { mimeType: 'image/jpeg' } });
      expect(r.status).toBe(409);
    });
  });

  test('logs never contain the token or the body', async () => {
    products.create.mockRejectedValue(new Error('db'));
    await call(server, `/api/v1/farms/${FARM_A}/products`, { token: 'secret-token-xyz', method: 'POST', key: 'log-00001', body: { name: 'ana@gmail.com' } });
    const out = JSON.stringify(log.error.mock.calls);
    expect(out).not.toContain('secret-token-xyz');
    expect(out).not.toContain('ana@gmail.com');
  });
});

describe('helpers', () => {
  test('idempotency forgets after its time', () => {
    let t = 0; const m = createIdempotency({ ttlMs: 10, now: () => t });
    m.set('k', 201, { a: 1 });
    expect(m.get('k')).toMatchObject({ status: 201 });
    t = 11;
    expect(m.get('k')).toBeNull();
  });

  test('rate limit allows N per minute, then resets', () => {
    let t = 0; const allow = createRateLimit({ perMinute: 2, now: () => t });
    expect([allow('u'), allow('u'), allow('u')]).toEqual([true, true, false]);
    expect(allow('other')).toBe(true);
    t = 60000;
    expect(allow('u')).toBe(true);
  });
});
