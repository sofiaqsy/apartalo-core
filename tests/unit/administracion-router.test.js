const http = require('http');
const express = require('express');
const { createAdministracionRouter, toParams, FORMS, PENDIENTES } = require('../../routes/administracion-router');

function start(router) {
  const app = express(); app.use(express.json()); app.use('/api/administracion', router);
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}
function call(server, path, { token, body, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const data = method === 'GET' ? '' : JSON.stringify(body || {});
    const req = http.request({ port: server.address().port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    });
    req.on('error', reject); req.end(data);
  });
}
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

describe('administración router', () => {
  let server;
  const verifyToken = jest.fn();
  const fetchImpl = jest.fn();
  const negocios = { 'BIZ-002': { id: 'BIZ-002', farmId: 'farm-rosal' }, 'BIZ-NOFARM': { id: 'BIZ-NOFARM' } };
  beforeAll(async () => {
    server = await start(createAdministracionRouter({
      getNegocio: id => negocios[id] || null,
      verifyToken, fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'sb_publishable_x',
    }));
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => { jest.clearAllMocks(); verifyToken.mockResolvedValue({ uid: 'u1' }); });

  test('no token -> 401 and the database is never called', async () => {
    expect((await call(server, '/api/administracion/BIZ-002/registrar/gasto')).status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('bad token -> 401; Firebase down -> 503', async () => {
    verifyToken.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/id-token-expired' }));
    expect((await call(server, '/api/administracion/BIZ-002/registrar/gasto', { token: 't' })).status).toBe(401);
    verifyToken.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/not-initialized' }));
    expect((await call(server, '/api/administracion/BIZ-002/registrar/gasto', { token: 't' })).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('unknown business or a business without a farm -> 404', async () => {
    expect((await call(server, '/api/administracion/BIZ-999/registrar/gasto', { token: 't' })).status).toBe(404);
    expect((await call(server, '/api/administracion/BIZ-NOFARM/registrar/gasto', { token: 't' })).status).toBe(404);
  });
  test('only the allowed forms exist', async () => {
    expect((await call(server, '/api/administracion/BIZ-002/registrar/borrar', { token: 't' })).status).toBe(404);
    expect(Object.keys(FORMS).sort()).toEqual(['adelanto', 'aprobarAdelanto', 'areasPersona', 'corregirArea', 'entrega', 'gasto', 'ingreso', 'pago', 'pagoGasto', 'precio', 'proveedor', 'rechazarAdelanto', 'retiro']);
  });
  test('a form forwards the person\'s own token (never a service key) and only allowed fields', async () => {
    fetchImpl.mockResolvedValue(reply(200, { expense_id: 'EX-0001', payment_id: 'PY-0001' }));
    const r = await call(server, '/api/administracion/BIZ-002/registrar/gasto', {
      token: 'person-token',
      body: { categoria: 'Transporte', centro: 'coffee', monto: 80, metodo: 'transfer', operacion: ' 222222 ', descripcion: ' Flete ', clientRef: 'exp-0001-abcd', p_business_id: 'other-farm', hack: 'x' },
    });
    expect(r).toEqual({ status: 200, body: { ok: true, result: { expense_id: 'EX-0001', payment_id: 'PY-0001' } } });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://db.example/rest/v1/rpc/admin_request_expense_v5');
    expect(opts.headers.Authorization).toBe('Bearer person-token');
    expect(opts.headers.apikey).toBe('sb_publishable_x');
    // A gasto is a request: how it was paid and the operation number are not sent (Administración pays it).
    expect(JSON.parse(opts.body)).toEqual({
      p_business_id: 'farm-rosal', p_category: 'Transporte', p_cost_centre: 'coffee', p_amount: 80,
      p_description: 'Flete', p_client_ref: 'exp-0001-abcd',
    });
  });
  test('database refusals come back as the plain message', async () => {
    fetchImpl.mockResolvedValue(reply(400, { code: 'P0001', message: 'Only the owner releases advances.' }));
    const r = await call(server, '/api/administracion/BIZ-002/registrar/adelanto', { token: 't', body: { personaId: 'P-MIS', monto: 1500 } });
    expect(r).toEqual({ status: 400, body: { error: 'Only the owner releases advances.' } });
    fetchImpl.mockResolvedValue(reply(401, { message: 'JWT invalid' }));
    expect((await call(server, '/api/administracion/BIZ-002/registrar/gasto', { token: 't', body: {} })).status).toBe(403);
  });
  test('database unreachable -> 502', async () => {
    fetchImpl.mockRejectedValue(new Error('offline'));
    expect((await call(server, '/api/administracion/BIZ-002/registrar/gasto', { token: 't', body: {} })).status).toBe(502);
  });
  test('pendientes reads the four lists of this farm only', async () => {
    fetchImpl.mockImplementation(async url => reply(200, [{ url }]));
    const r = await call(server, '/api/administracion/BIZ-002/pendientes', { token: 't', method: 'GET' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['adelantos', 'adelantosPorAprobar', 'banco', 'gastosPorPagar', 'porPagar', 'porRevisar', 'sinPrecio']);
    for (const [, opts] of fetchImpl.mock.calls) expect(opts.headers.Authorization).toBe('Bearer t');
    expect(fetchImpl.mock.calls.map(c => c[0]).every(u => u.includes('business_id=eq.farm-rosal'))).toBe(true);
    expect(r.body.adelantos[0].url).toContain('/advance_balances?');
    expect(r.body.adelantos[0].url).toContain('open_balance=gt.0');
  });
  test('personas marks farmers and buyers', async () => {
    fetchImpl.mockImplementation(async url => {
      if (url.includes('/parties?')) return reply(200, [{ id: 'P-J', name: 'José Luis' }, { id: 'P-MIS', name: 'Misael' }]);
      if (url.includes('/farmers?')) return reply(200, [{ party_id: 'P-J', sells: 'parchment', collected_by: 'P-MIS' }]);
      return reply(200, [{ party_id: 'P-MIS', active: true }]);
    });
    const r = await call(server, '/api/administracion/BIZ-002/personas', { token: 't', method: 'GET' });
    expect(r.body).toEqual([
      { id: 'P-J', nombre: 'José Luis', agricultor: true, comprador: false, recogidoPor: 'P-MIS' },
      { id: 'P-MIS', nombre: 'Misael', agricultor: false, comprador: true, recogidoPor: null },
    ]);
  });
  test('resumen: owner gets the month view, staff gets the role only, others 403', async () => {
    fetchImpl.mockImplementation(async url => url.includes('my_memberships')
      ? reply(200, [{ business_id: 'farm-rosal', role: 'owner' }])
      : reply(200, [{ account: 'BCP', closing: 8720 }]));
    expect((await call(server, '/api/administracion/BIZ-002/resumen', { token: 't', method: 'GET' })).body)
      .toEqual({ rol: 'owner', meses: [{ account: 'BCP', closing: 8720 }] });
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () => reply(200, [{ business_id: 'farm-rosal', role: 'staff' }]));
    expect((await call(server, '/api/administracion/BIZ-002/resumen', { token: 't', method: 'GET' })).body).toEqual({ rol: 'staff', meses: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockImplementation(async () => reply(200, [{ business_id: 'other-farm', role: 'owner' }]));
    expect((await call(server, '/api/administracion/BIZ-002/resumen', { token: 't', method: 'GET' })).status).toBe(403);
  });
});

describe('mi área', () => {
  test('shows only an area the person belongs to; asking for another falls back to their first', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('my_areas')) return reply(200, [{ area: 'fulfillment', name: 'Logística', role: 'lead' }]);
      return reply(200, [{ url }]);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/mi-area?area=finance', { token: 't', method: 'GET' });
    expect(r.body.area).toBe('fulfillment');
    expect(decodeURIComponent(r.body.meses[0].url)).toContain('area=in.(fulfillment)');
    expect(r.body.gastos[0].url).toContain('/area_expenses_recent_v2?');
    await new Promise(res => server.close(res));
  });

  test('several areas at once, only the person\'s own; todas = all of them', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('my_areas')) return reply(200, [{ area: 'sourcing', name: 'Compras', principal: true }, { area: 'farm', name: 'Finca', principal: false }]);
      return reply(200, [{ url }]);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const dos = await call(server, '/api/administracion/BIZ-002/mi-area?area=farm,finance,sourcing', { token: 't', method: 'GET' });
    expect(dos.body.elegidas).toEqual(['farm', 'sourcing']); // finance is not hers: left out
    expect(decodeURIComponent(dos.body.meses[0].url)).toContain('area=in.(farm,sourcing)');
    const todas = await call(server, '/api/administracion/BIZ-002/mi-area?area=todas', { token: 't', method: 'GET' });
    expect(todas.body.elegidas).toEqual(['sourcing', 'farm']);
    const nada = await call(server, '/api/administracion/BIZ-002/mi-area?area=risk', { token: 't', method: 'GET' });
    expect(nada.body.elegidas).toEqual(['sourcing']); // falls back to the first (principal)
    await new Promise(res => server.close(res));
  });

  test('the gasto sends the chosen area and links', () => {
    expect(toParams(FORMS.gasto, { categoria: 'Flete', monto: 85, area: 'fulfillment', envioId: 'SH-0001' }, 'f'))
      .toEqual({ p_business_id: 'f', p_category: 'Flete', p_amount: 85, p_area: 'fulfillment', p_shipment_id: 'SH-0001' });
  });
});

describe('categorías', () => {
  test('come from the guide: only the ones still offered, with their phone text', async () => {
    const fetchImpl = jest.fn(async url => reply(200, url.includes('expense_category_guide')
      ? [{ category: 'Combustible', what_goes_here: 'Gasolina y petróleo', main: true }] : [{ id: 'farm', name: 'Finca' }]));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/categorias', { token: 't', method: 'GET' });
    expect(r.body.categorias[0].category).toBe('Combustible');
    const guideUrl = fetchImpl.mock.calls.map(c => c[0]).find(u => u.includes('expense_category_guide'));
    expect(guideUrl).toContain('active=is.true');
    expect(guideUrl).toContain('what_goes_here');
    await new Promise(res => server.close(res));
  });
});

describe('combustible', () => {
  test('the gasto sends the optional Para qué; the area is left to the database', () => {
    expect(toParams(FORMS.gasto, { categoria: 'Combustible', monto: 50, paraQue: 'compra' }, 'f'))
      .toEqual({ p_business_id: 'f', p_category: 'Combustible', p_amount: 50, p_purpose: 'compra' });
  });
  test('sugerir-area asks the database with the person\'s token and the date', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { area: 'sourcing', source: 'same_day' }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/sugerir-area?categoria=Combustible&fecha=2026-11-22', { token: 'tk', method: 'GET' });
    expect(r.body).toEqual({ area: 'sourcing', source: 'same_day' });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://db.example/rest/v1/rpc/suggest_expense_area_v2');
    expect(JSON.parse(opts.body)).toEqual({ p_category: 'Combustible', p_business_id: 'farm-rosal', p_date: '2026-11-22' });
    expect(opts.headers.Authorization).toBe('Bearer tk');
    expect((await call(server, '/api/administracion/BIZ-002/sugerir-area', { token: 'tk', method: 'GET' })).status).toBe(400);
    await new Promise(res => server.close(res));
  });
  test('the owner corrects an area with a new record', () => {
    expect(toParams(FORMS.corregirArea, { gastoId: 'EX-0009', area: 'sourcing', motivo: 'Compra' }, 'f'))
      .toEqual({ p_business_id: 'f', p_expense_id: 'EX-0009', p_area: 'sourcing', p_reason: 'Compra' });
    expect(PENDIENTES.porRevisar.view).toBe('expenses_to_review_v2');
  });
});

describe('buscar personas', () => {
  const parties = [
    { id: 'P-1', name: 'Pedro Ramírez Ñique', notes: 'También: Chato. Vende café.' },
    { id: 'P-2', name: 'Ferretería Ejemplo SAC', notes: 'Proveedor: materiales.' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `P-F${i}`, name: `Agricultor ${String(i).padStart(2, '0')}`, notes: null })),
  ];
  async function servidor() {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('/parties?')) return reply(200, parties);
      if (url.includes('/farmers?')) return reply(200, [{ party_id: 'P-1', sells: 'parchment', collected_by: null },
        ...Array.from({ length: 30 }, (_, i) => ({ party_id: `P-F${i}`, sells: 'cherry', collected_by: null }))]);
      return reply(200, []);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    return new Promise(r => { const s = app.listen(0, () => r(s)); });
  }
  test('finds by nickname without accents, and only farmers when asked', async () => {
    const server = await servidor();
    const r = await call(server, '/api/administracion/BIZ-002/personas/buscar?q=chato&rol=agricultor', { token: 't', method: 'GET' });
    expect(r.body.personas.map(p => p.nombre)).toEqual(['Pedro Ramírez Ñique']);
    expect(r.body.personas[0]).toMatchObject({ agricultor: true, vende: 'parchment', detalle: 'También: Chato. Vende café.' });
    const j = await call(server, '/api/administracion/BIZ-002/personas/buscar?q=NIQUE', { token: 't', method: 'GET' });
    expect(j.body.total).toBe(1);
    const tienda = await call(server, '/api/administracion/BIZ-002/personas/buscar?q=ferreteria&rol=agricultor', { token: 't', method: 'GET' });
    expect(tienda.body.total).toBe(0);
    await new Promise(res => server.close(res));
  });
  test('pages of 20, with hayMas', async () => {
    const server = await servidor();
    const p1 = await call(server, '/api/administracion/BIZ-002/personas/buscar?rol=agricultor', { token: 't', method: 'GET' });
    expect(p1.body.personas).toHaveLength(20);
    expect(p1.body).toMatchObject({ total: 31, hayMas: true });
    const p2 = await call(server, '/api/administracion/BIZ-002/personas/buscar?rol=agricultor&offset=20', { token: 't', method: 'GET' });
    expect(p2.body.personas).toHaveLength(11);
    expect(p2.body.hayMas).toBe(false);
    const big = await call(server, '/api/administracion/BIZ-002/personas/buscar?limit=500', { token: 't', method: 'GET' });
    expect(big.body.personas).toHaveLength(32 > 50 ? 50 : 32);
    await new Promise(res => server.close(res));
  });
});

describe('equipo', () => {
  async function servidor(fetchImpl) {
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    return new Promise(r => { const s = app.listen(0, () => r(s)); });
  }
  test('the team comes from the database with the person\'s token (owners only, the database decides)', async () => {
    const fetchImpl = jest.fn(async () => reply(200, [{ profile_id: 'a', name: 'Persona Uno', role: 'staff', areas: [] }]));
    const server = await servidor(fetchImpl);
    const r = await call(server, '/api/administracion/BIZ-002/equipo', { token: 'tk', method: 'GET' });
    expect(r.body.equipo[0].name).toBe('Persona Uno');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://db.example/rest/v1/rpc/team_members');
    fetchImpl.mockImplementation(async () => reply(400, { code: 'P0001', message: 'Only Administración sees the team.' }));
    expect((await call(server, '/api/administracion/BIZ-002/equipo', { token: 'tk', method: 'GET' })).body).toEqual({ error: 'Only Administración sees the team.' });
    await new Promise(res => server.close(res));
  });
  test('suggested areas for a person; a bad id is refused before the database', async () => {
    const fetchImpl = jest.fn(async () => reply(200, [{ area: 'sourcing', name: 'Compras', records: 4 }]));
    const server = await servidor(fetchImpl);
    const id = '11111111-2222-3333-4444-555555555555';
    const r = await call(server, `/api/administracion/BIZ-002/equipo/${id}/sugerencia`, { token: 'tk', method: 'GET' });
    expect(r.body.sugeridas[0].area).toBe('sourcing');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ p_profile_id: id, p_business_id: 'farm-rosal' });
    expect((await call(server, '/api/administracion/BIZ-002/equipo/x;drop/sugerencia', { token: 'tk', method: 'GET' })).status).toBe(400);
    await new Promise(res => server.close(res));
  });
  test('setting areas sends the list and the principal', () => {
    expect(toParams(FORMS.areasPersona, { perfilId: 'p1', areas: ['sourcing', 'farm'], principal: 'farm' }, 'f'))
      .toEqual({ p_business_id: 'f', p_profile_id: 'p1', p_areas: ['sourcing', 'farm'], p_principal: 'farm' });
  });
});

describe('pendientes', () => {
  test('purchases to pay carry their delivery id', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('/purchase_balances?')) return reply(200, [{ id: 'PU-0001', still_owed: 300 }]);
      if (url.includes('/purchases?')) return reply(200, [{ id: 'PU-0001', delivery_id: 'DL-0001' }]);
      return reply(200, []);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/pendientes', { token: 't', method: 'GET' });
    expect(r.body.porPagar).toEqual([{ id: 'PU-0001', still_owed: 300, delivery_id: 'DL-0001' }]);
    expect(decodeURIComponent(fetchImpl.mock.calls.find(c => c[0].includes('/purchases?'))[0])).toContain('id=in.(PU-0001)');
    await new Promise(res => server.close(res));
  });
});

describe('solicitudes', () => {
  test('staff see only their own requests; the owner sees everyone\'s', async () => {
    const fetchImpl = jest.fn();
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const get = () => call(server, '/api/administracion/BIZ-002/solicitudes', { token: 't', method: 'GET' });
    fetchImpl.mockImplementation(async url => url.includes('my_memberships') ? reply(200, [{ business_id: 'farm-rosal', role: 'staff' }]) : reply(200, [{ url }]));
    let r = await get();
    expect(r.body.rol).toBe('staff');
    expect(r.body.solicitudes[0].url).toContain('mine=is.true');
    fetchImpl.mockImplementation(async url => url.includes('my_memberships') ? reply(200, [{ business_id: 'farm-rosal', role: 'owner' }]) : reply(200, [{ url }]));
    r = await get();
    expect(r.body.rol).toBe('owner');
    expect(r.body.solicitudes[0].url).not.toContain('mine=');
    await new Promise(res => server.close(res));
  });
});

describe('adelanto is a request', () => {
  test('no payment fields are sent with the request; approval carries them', () => {
    expect(toParams(FORMS.adelanto, { personaId: 'P-0001', monto: 1500, motivo: 'Compras', metodo: 'transfer', operacion: '1' }, 'f'))
      .toEqual({ p_business_id: 'f', p_party_id: 'P-0001', p_amount: 1500, p_reason: 'Compras' });
    expect(toParams(FORMS.aprobarAdelanto, { solicitudId: 'SOL-0001', metodo: 'transfer', operacion: '888888' }, 'f'))
      .toEqual({ p_business_id: 'f', p_request_id: 'SOL-0001', p_method: 'transfer', p_bank_reference: '888888' });
  });
});

describe('pagoGasto', () => {
  test('pays a requested expense with method and operation number', () => {
    expect(toParams(FORMS.pagoGasto, { gastoId: 'EX-0001', metodo: 'transfer', operacion: '777777' }, 'farm-rosal'))
      .toEqual({ p_business_id: 'farm-rosal', p_expense_id: 'EX-0001', p_method: 'transfer', p_bank_reference: '777777' });
  });
});

describe('toParams', () => {
  test('the farm always comes from the server, never from the body', () => {
    expect(toParams(FORMS.retiro, { monto: 400, p_business_id: 'x' }, 'farm-rosal')).toEqual({ p_business_id: 'farm-rosal', p_amount: 400 });
  });
});

describe('procesos', () => {
  const resumenes = url => url.includes('purchasing_summary') ? { mes: { recibidos: 2 } }
    : url.includes('sales_by_month') ? [{ month: '2026-11-01', orders: 3, total: 3088 }]
    : url.includes('farm_summary') ? { parcelas: { n: 1 } }
    : url.includes('logistics_summary') ? { por_despachar: 3 } : { verde_kg: 760 };
  async function pedir(areas, token = 'person-token') {
    const fetchImpl = jest.fn(async url => reply(200, url.includes('my_areas_v2') ? areas.map(area => ({ area })) : resumenes(url)));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/procesos', { token, method: 'GET' });
    await new Promise(res => server.close(res));
    return { r, fetchImpl };
  }
  test('an owner (every area) gets the four summaries, with the person\'s own token', async () => {
    const { r, fetchImpl } = await pedir(['farm', 'sourcing', 'production', 'commercial', 'fulfillment', 'finance']);
    expect(r.body).toEqual({ finca: { parcelas: { n: 1 } }, compras: { mes: { recibidos: 2 } }, produccion: { verde_kg: 760 },
      comercial: { meses: [{ month: '2026-11-01', orders: 3, total: 3088 }] }, logistica: { por_despachar: 3 } });
    for (const [, opts] of fetchImpl.mock.calls) {
      expect(opts.headers.Authorization).toBe('Bearer person-token');
      expect(JSON.parse(opts.body)).toEqual({ p_business_id: 'farm-rosal' });
    }
  });
  test('staff only get the processes of their own areas; the others are never asked for', async () => {
    const { r, fetchImpl } = await pedir(['sourcing', 'quality']);
    expect(Object.keys(r.body)).toEqual(['compras']);
    const urls = fetchImpl.mock.calls.map(c => c[0]).join(' ');
    for (const fn of ['farm_summary', 'production_summary', 'apartalo_sales_by_month', 'logistics_summary']) expect(urls).not.toContain(fn);
  });
  test('a person without areas gets nothing', async () => {
    const { r } = await pedir([]);
    expect(r.body).toEqual({});
  });
  test('a database refusal is passed on in plain words', async () => {
    const fetchImpl = jest.fn(async () => reply(400, { message: 'You are not a member of this business.' }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/procesos', { token: 't', method: 'GET' });
    expect(r).toEqual({ status: 400, body: { error: 'You are not a member of this business.' } });
    await new Promise(res => server.close(res));
  });
});

describe('area of each pending expense', () => {
  test('gastos por pagar and gasto requests carry their area', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('expenses_effective_area')) return reply(200, [{ id: 'EX-1', area: 'farm' }]);
      if (url.includes('expenses_to_pay')) return reply(200, [{ id: 'EX-1', amount: 60 }]);
      if (url.includes('my_memberships')) return reply(200, [{ business_id: 'farm-rosal', role: 'owner' }]);
      if (url.includes('my_requests')) return reply(200, [{ kind: 'gasto', id: 'EX-1' }, { kind: 'adelanto', id: 'SOL-1' }]);
      return reply(200, []);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const p = await call(server, '/api/administracion/BIZ-002/pendientes', { token: 't', method: 'GET' });
    expect(p.body.gastosPorPagar).toEqual([{ id: 'EX-1', amount: 60, area: 'farm' }]);
    const s = await call(server, '/api/administracion/BIZ-002/solicitudes', { token: 't', method: 'GET' });
    expect(s.body.solicitudes).toEqual([{ kind: 'gasto', id: 'EX-1', area: 'farm' }, { kind: 'adelanto', id: 'SOL-1' }]);
    await new Promise(res => server.close(res));
  });
});

describe('providers of a process', () => {
  test('area=farm lists only the providers set in Finca or who supplied its gastos', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('/party_areas?')) return reply(200, [{ party_id: 'P-0020' }]);
      if (url.includes('/expenses?')) return reply(200, [{ supplier_party_id: 'P-0031' }]);
      if (url.includes('/parties?')) return reply(200, [
        { id: 'P-0020', name: 'Bulcar Tech', kind: 'business' }, { id: 'P-0023', name: 'Electrocentro', kind: 'business' },
        { id: 'P-0031', name: 'Ferretería Ejemplo', kind: 'business' }, { id: 'P-0001', name: 'Agricultor Uno', kind: 'person' }]);
      return reply(200, []);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/personas/buscar?area=farm', { token: 't', method: 'GET' });
    expect(r.body.personas.map(p => p.nombre)).toEqual(['Bulcar Tech', 'Ferretería Ejemplo']);
    expect(r.body.total).toBe(2);
    const raro = await call(server, "/api/administracion/BIZ-002/personas/buscar?area=farm'%20or", { token: 't', method: 'GET' });
    expect(raro.body.total).toBe(4); // an invalid area is ignored, never sent to the database
    await new Promise(res => server.close(res));
  });
});

describe('Registrar compra', () => {
  test('sends the linked product to admin_record_delivery_v3', () => {
    expect(FORMS.entrega.fn).toBe('admin_record_delivery_v3');
    expect(toParams(FORMS.entrega, { agricultorId: 'P-1', estado: 'parchment', kg: 40, productoId: 'prod-blend' }, 'f'))
      .toEqual({ p_business_id: 'f', p_farmer_id: 'P-1', p_coffee_state: 'parchment', p_kg: 40, p_product_id: 'prod-blend' });
  });
});

describe('compras list and detail', () => {
  async function servidor(areas, reply2) {
    const fetchImpl = jest.fn(async (url, opts) => {
      if (url.includes('my_areas_v2')) return reply(200, areas.map(area => ({ area })));
      return reply2(url, opts);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    return { server, fetchImpl };
  }
  test('pages of purchases with hayMas, limit at most 50', async () => {
    const { server, fetchImpl } = await servidor(['sourcing'], () => reply(200, { total: 3, filas: [{ id: 'DL-1' }, { id: 'DL-2' }] }));
    const r = await call(server, '/api/administracion/BIZ-002/compras?offset=0&limit=500', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ compras: [{ id: 'DL-1' }, { id: 'DL-2' }], total: 3, hayMas: true });
    const body = JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('purchases_page_v2'))[1].body);
    expect(body).toEqual({ p_business_id: 'farm-rosal', p_offset: 0, p_limit: 50 });
    await new Promise(res => server.close(res));
  });
  test('detail of one purchase', async () => {
    const { server, fetchImpl } = await servidor(['sourcing'], () => reply(200, { id: 'DL-1', agricultor: 'Agricultor Uno' }));
    const r = await call(server, '/api/administracion/BIZ-002/compras/DL-1', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ compra: { id: 'DL-1', agricultor: 'Agricultor Uno' } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('purchase_detail_v2'))[1].body)).toEqual({ p_business_id: 'farm-rosal', p_delivery_id: 'DL-1' });
    await new Promise(res => server.close(res));
  });
  test('someone without the Compras area gets 403 and the database is not asked', async () => {
    const { server, fetchImpl } = await servidor(['production'], () => reply(200, {}));
    expect((await call(server, '/api/administracion/BIZ-002/compras', { token: 't', method: 'GET' })).status).toBe(403);
    expect((await call(server, '/api/administracion/BIZ-002/compras/DL-1', { token: 't', method: 'GET' })).status).toBe(403);
    expect(fetchImpl.mock.calls.some(c => c[0].includes('purchases_page') || c[0].includes('purchase_detail'))).toBe(false);
    await new Promise(res => server.close(res));
  });
});
