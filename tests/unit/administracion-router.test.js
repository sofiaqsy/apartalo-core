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
    expect(Object.keys(FORMS).sort()).toEqual(['adelanto', 'aprobarAdelanto', 'areasPersona', 'corregirArea', 'entrega', 'gasto', 'ingreso', 'pago', 'pagoGasto', 'precio', 'proveedor', 'rechazarAdelanto', 'pagoConAdelanto', 'retiro', 'solicitarPago', 'editarProveedor', 'cuentaProveedor', 'quitarCuenta', 'quitarEvidencia', 'pagoDesdeAdelantos'].sort());
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
  async function servidor(fetchImpl) {
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    return new Promise(r => { const s = app.listen(0, () => r(s)); });
  }
  test('the database filters and cuts the page; nothing else is read', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { total: 31, personas: Array.from({ length: 20 }, (_, i) => ({ id: `P-F${i}`, nombre: `Agricultor ${i}` })) }));
    const server = await servidor(fetchImpl);
    const r = await call(server, '/api/administracion/BIZ-002/personas/buscar?q=chato&rol=agricultor&offset=0', { token: 't', method: 'GET' });
    expect(r.body.personas).toHaveLength(20);
    expect(r.body).toMatchObject({ total: 31, hayMas: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://db.example/rest/v1/rpc/parties_page');
    expect(JSON.parse(opts.body)).toEqual({ p_business_id: 'farm-rosal', p_q: 'chato', p_rol: 'agricultor', p_area: null, p_offset: 0, p_limit: 20 });
    await new Promise(res => server.close(res));
  });
  test('the last page says no more; limit at most 50; odd values are never sent', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { total: 31, personas: Array.from({ length: 11 }, (_, i) => ({ id: `P-${i}` })) }));
    const server = await servidor(fetchImpl);
    const p2 = await call(server, "/api/administracion/BIZ-002/personas/buscar?rol=jefe&offset=20&limit=500&area=farm'%20or", { token: 't', method: 'GET' });
    expect(p2.body.hayMas).toBe(false);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ p_rol: null, p_area: null, p_offset: 20, p_limit: 50 });
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
  test('purchases to pay carry their delivery id and whether payment was requested', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('/purchase_balances?')) return reply(200, [{ id: 'PU-0001', still_owed: 300 }]);
      if (url.includes('/purchases?')) return reply(200, [{ id: 'PU-0001', delivery_id: 'DL-0001' }]);
      if (url.includes('/purchase_open_requests?')) return reply(200, [{ purchase_id: 'PU-0001' }]);
      return reply(200, []);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/pendientes', { token: 't', method: 'GET' });
    expect(r.body.porPagar).toEqual([{ id: 'PU-0001', still_owed: 300, delivery_id: 'DL-0001', pago_solicitado: true }]);
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
    : url.includes('logistics_summary') ? { por_despachar: 3 }
    : url.includes('finance_summary') ? { compras: { n: 1 } } : { verde_kg: 760 };
  async function pedir(areas, token = 'person-token', ruta = '/procesos') {
    const fetchImpl = jest.fn(async url => reply(200, url.includes('my_areas_v2') ? areas.map(area => ({ area })) : resumenes(url)));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, `/api/administracion/BIZ-002${ruta}`, { token, method: 'GET' });
    await new Promise(res => server.close(res));
    return { r, fetchImpl };
  }
  test('an owner (every area) gets the four summaries, with the person\'s own token', async () => {
    const { r, fetchImpl } = await pedir(['farm', 'sourcing', 'production', 'commercial', 'fulfillment', 'finance']);
    expect(r.body).toEqual({ finca: { parcelas: { n: 1 } }, compras: { mes: { recibidos: 2 } }, produccion: { verde_kg: 760 },
      comercial: { meses: [{ month: '2026-11-01', orders: 3, total: 3088 }] }, logistica: { por_despachar: 3 },
      finanzas: { compras: { n: 1 } } });
    // Producción counts roasted coffee by product, in the order of the Productos tab (4 Nov 2026).
    expect(fetchImpl.mock.calls.some(c => c[0].endsWith('rpc/production_summary_v6'))).toBe(true);
    for (const [, opts] of fetchImpl.mock.calls) {
      expect(opts.headers.Authorization).toBe('Bearer person-token');
      expect(JSON.parse(opts.body)).toEqual({ p_business_id: 'farm-rosal' });
    }
  });
  test('staff only get the processes of their own areas; the others are never asked for', async () => {
    const { r, fetchImpl } = await pedir(['sourcing', 'quality']);
    expect(Object.keys(r.body)).toEqual(['compras']);
    const urls = fetchImpl.mock.calls.map(c => c[0]).join(' ');
    for (const fn of ['farm_summary', 'production_summary', 'apartalo_sales_by_month', 'logistics_summary', 'finance_summary']) expect(urls).not.toContain(fn);
  });
  test('?solo=compras asks only for the Compras summary', async () => {
    const { r, fetchImpl } = await pedir(['farm', 'sourcing', 'production', 'finance'], 'person-token', '/procesos?solo=compras');
    expect(r.body).toEqual({ compras: { mes: { recibidos: 2 } } });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // my_areas_v2 and purchasing_summary_v2
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
  test('area=farm is passed to the database', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { total: 2, personas: [{ nombre: 'Bulcar Tech' }, { nombre: 'Ferretería Ejemplo' }] }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/personas/buscar?area=farm', { token: 't', method: 'GET' });
    expect(r.body.personas.map(p => p.nombre)).toEqual(['Bulcar Tech', 'Ferretería Ejemplo']);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).p_area).toBe('farm');
    await new Promise(res => server.close(res));
  });
});

describe('Registrar compra', () => {
  test('sends the linked product to admin_record_delivery_v4', () => {
    expect(FORMS.entrega.fn).toBe('admin_record_delivery_v4');
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
    const body = JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('purchases_page_v4'))[1].body);
    expect(body).toEqual({ p_business_id: 'farm-rosal', p_offset: 0, p_limit: 50 });
    await new Promise(res => server.close(res));
  });
  test('the Compras report asks the database for a range of months; a bad month is refused before it', async () => {
    const { server, fetchImpl } = await servidor(['sourcing'], () => reply(200, { meses: 5, franja: { kg: 60 } }));
    const ultimo = () => JSON.parse(fetchImpl.mock.calls.filter(c => c[0].includes('purchasing_report_v2')).pop()[1].body);
    const r = await call(server, '/api/administracion/BIZ-002/compras/reporte?desde=2026-05&hasta=2026-09', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ reporte: { meses: 5, franja: { kg: 60 } } });
    expect(ultimo()).toEqual({ p_business_id: 'farm-rosal', p_from: '2026-05-01', p_to: '2026-09-30' });
    await call(server, '/api/administracion/BIZ-002/compras/reporte?desde=2026-02&hasta=2026-02', { token: 't', method: 'GET' });
    expect(ultimo().p_to).toBe('2026-02-28');
    await call(server, '/api/administracion/BIZ-002/compras/reporte?anio=2026', { token: 't', method: 'GET' }); // the old form still works
    expect(ultimo()).toMatchObject({ p_from: '2026-01-01', p_to: '2026-12-31' });
    await call(server, '/api/administracion/BIZ-002/compras/reporte?anio=2026&mes=3', { token: 't', method: 'GET' });
    expect(ultimo()).toMatchObject({ p_from: '2026-03-01', p_to: '2026-03-31' });
    const n = fetchImpl.mock.calls.length;
    for (const q of ['desde=2026-13&hasta=2026-12', 'desde=2026-05', 'anio=2026&mes=13', '']) {
      expect((await call(server, `/api/administracion/BIZ-002/compras/reporte?${q}`, { token: 't', method: 'GET' })).status).toBe(400);
    }
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });
  test('green lots: Agregar café al lote and Cerrar lote send the person\'s data to the database, which decides', async () => {
    const lote = '11111111-2222-3333-4444-555555555555';
    const { server, fetchImpl } = await servidor(['production'], () => reply(200, { lote: 'L-7' }));
    let r = await call(server, `/api/administracion/BIZ-002/produccion/lotes-verdes/${lote}/agregar`, {
      token: 't', method: 'POST', body: { kgVerde: '240', kgPergamino: 300, compras: ['DL-0001', 'x y', 5], calidadAprobo: true, costo: 2400, clientRef: 'c1' },
    });
    expect(r.body).toEqual({ ok: true, resultado: { lote: 'L-7' } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/add_green_kg'))[1].body)).toEqual({
      p_business_id: 'farm-rosal', p_green_lot_id: lote, p_green_kg: 240, p_parchment_kg: 300, p_compras: ['DL-0001'],
      p_quality_ok: true, p_cost_total: 2400, p_note: null, p_client_ref: 'c1',
    });
    r = await call(server, `/api/administracion/BIZ-002/produccion/lotes-verdes/${lote}/cerrar`, { token: 't', method: 'POST', body: { kgContados: 0, motivo: 'Conteo' } });
    expect(r.body.ok).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/close_green_lot'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_green_lot_id: lote, p_counted_kg: 0, p_reason: 'Conteo', p_client_ref: null });
    r = await call(server, `/api/administracion/BIZ-002/produccion/lotes-verdes/${lote}`, { token: 't', method: 'GET' });
    expect(r.body).toEqual({ lote: { lote: 'L-7' } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/green_lot_detail_v3'))[1].body)).toEqual({ p_business_id: 'farm-rosal', p_green_lot_id: lote });
    r = await call(server, `/api/administracion/BIZ-002/produccion/lotes-verdes/${lote}/cuenta?offset=20&limit=500`, { token: 't', method: 'GET' });
    expect(r.body).toEqual({ cuenta: { lote: 'L-7' } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/green_lot_statement_page'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_green_lot_id: lote, p_offset: 20, p_limit: 50 }); // never more than 50
    r = await call(server, `/api/administracion/BIZ-002/produccion/lotes-verdes/${lote}/compras`, { token: 't', method: 'GET' });
    expect(fetchImpl.mock.calls.some(c => c[0].endsWith('rpc/green_lot_compras_v2'))).toBe(true);
    const n = fetchImpl.mock.calls.length;
    expect((await call(server, '/api/administracion/BIZ-002/produccion/lotes-verdes/L-7/cerrar', { token: 't', method: 'POST', body: {} })).status).toBe(400);
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });
  test('the detail of a roasted lot: only for the Producción area, and a bad id never reaches the database', async () => {
    const id = '244280b8-69d7-4f62-a0ef-b158729e7e25';
    const { server, fetchImpl } = await servidor(['production'], () => reply(200, { lote: 'L-7', kg_verde: 100 }));
    const r = await call(server, `/api/administracion/BIZ-002/produccion/tostados/${id}`, { token: 't', method: 'GET' });
    expect(r.body).toEqual({ tostado: { lote: 'L-7', kg_verde: 100 } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/roast_lot_detail'))[1].body)).toEqual({ p_business_id: 'farm-rosal', p_event_id: id });
    const n = fetchImpl.mock.calls.length;
    expect((await call(server, '/api/administracion/BIZ-002/produccion/tostados/abc', { token: 't', method: 'GET' })).status).toBe(400);
    expect(fetchImpl.mock.calls.length).toBe(n);
    const producto = '64203b65-4f36-4131-9daf-8c18d3bee8b2';
    const c = await call(server, `/api/administracion/BIZ-002/produccion/tostados/${id}/cuenta?producto=${producto}&offset=20`, { token: 't', method: 'GET' });
    expect(c.body).toEqual({ cuenta: { lote: 'L-7', kg_verde: 100 } });
    expect(JSON.parse(fetchImpl.mock.calls.find(x => x[0].endsWith('rpc/roast_lot_statement_page'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_event_id: id, p_product_id: producto, p_offset: 20, p_limit: 20 });
    expect((await call(server, `/api/administracion/BIZ-002/produccion/tostados/${id}/cuenta?producto=x`, { token: 't', method: 'GET' })).status).toBe(400);
    await new Promise(res => server.close(res));
    const otro = await servidor(['sourcing'], () => reply(200, {}));
    expect((await call(otro.server, `/api/administracion/BIZ-002/produccion/tostados/${id}`, { token: 't', method: 'GET' })).status).toBe(403);
    expect(otro.fetchImpl.mock.calls.some(c => c[0].includes('roast_lot_detail'))).toBe(false);
    await new Promise(res => otro.server.close(res));
  });
  test('the Finca and Finanzas reports ask the database for a range of months', async () => {
    const { server, fetchImpl } = await servidor(['farm', 'finance'], () => reply(200, { meses: 1 }));
    for (const [ruta, fn] of [['finca', 'farm_report'], ['finanzas', 'finance_report']]) {
      const r = await call(server, `/api/administracion/BIZ-002/${ruta}/reporte?desde=2026-02&hasta=2026-02`, { token: 't', method: 'GET' });
      expect(r.body).toEqual({ reporte: { meses: 1 } });
      expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith(`rpc/${fn}`))[1].body))
        .toEqual({ p_business_id: 'farm-rosal', p_from: '2026-02-01', p_to: '2026-02-28' });
      expect((await call(server, `/api/administracion/BIZ-002/${ruta}/reporte?desde=2026-2`, { token: 't', method: 'GET' })).status).toBe(400);
    }
    await new Promise(res => server.close(res));
  });
  test('Comercialización, Últimos pagos: the payments with their orders, only for the Comercial area', async () => {
    const fetchImpl = jest.fn(async url => reply(200, url.includes('my_areas_v2') ? [{ area: 'commercial' }]
      : { pagos: [{ id: 'p1', pedido_id: 'o1', numero: 'ORD-1' }, { id: 'p2', pedido_id: 'o9', numero: 'ORD-9' }], total: 2, hay_mas: false }));
    const pedidosPorIds = jest.fn(async () => ({ pedidos: [{ supabaseId: 'o1', id: 'ORD-1', cliente: 'Cafe Uno' }] }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl, pedidosPorIds,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/comercial/pagos?offset=20', { token: 't', method: 'GET' });
    expect(r.body.pagos[0].pedido).toEqual({ supabaseId: 'o1', id: 'ORD-1', cliente: 'Cafe Uno' });
    expect(r.body.pagos[1].pedido).toBeUndefined(); // not this farm's: no detail, but the row stays
    expect(pedidosPorIds).toHaveBeenCalledWith('farm-rosal', ['o1', 'o9']);
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/commercial_payments_page'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_offset: 20, p_limit: 20 });
    await new Promise(res => server.close(res));
  });
  test('a bank line detail brings each store order as the Pedidos tab has it (pedido_app)', async () => {
    const fetchImpl = jest.fn(async url => reply(200, url.includes('my_areas_v2') ? [{ area: 'finance' }]
      : { id: 7, estado: 'Conciliado', pedido: { id: 'o2', numero: 'ORD-2' },
          sugerencias: [{ tipo: 'pedido', ref: 'o1', titulo: 'Cafe Uno' }, { tipo: 'gasto', ref: 'EX-1' }] }));
    const pedidosPorIds = jest.fn(async () => ({ pedidos: [{ supabaseId: 'o1', id: 'ORD-1' }, { supabaseId: 'o2', id: 'ORD-2', pagos: [] }] }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl, pedidosPorIds,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/finanzas/movimientos/7', { token: 't', method: 'GET' });
    expect(pedidosPorIds).toHaveBeenCalledWith('farm-rosal', ['o1', 'o2']);
    expect(r.body.movimiento.sugerencias[0].pedido_app).toEqual({ supabaseId: 'o1', id: 'ORD-1' });
    expect(r.body.movimiento.sugerencias[1].pedido_app).toBeUndefined();
    expect(r.body.movimiento.pedido.pedido_app).toEqual({ supabaseId: 'o2', id: 'ORD-2', pagos: [] });
    await new Promise(res => server.close(res));
  });
  test('Comercialización: its report, customers and products, only for the Comercial area', async () => {
    const { server, fetchImpl } = await servidor(['commercial'], () => reply(200, { clientes: [], total: 0 }));
    const r = await call(server, '/api/administracion/BIZ-002/comercial/reporte?desde=2026-10&hasta=2026-10', { token: 't', method: 'GET' });
    expect(r.status).toBe(200);
    expect(fetchImpl.mock.calls.some(c => c[0].endsWith('rpc/commercial_report_v3'))).toBe(true);
    await call(server, '/api/administracion/BIZ-002/comercial/clientes?offset=20&q=cafe', { token: 't', method: 'GET' });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/commercial_customers_page'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_offset: 20, p_limit: 20, p_buscar: 'cafe' });
    await call(server, '/api/administracion/BIZ-002/comercial/productos', { token: 't', method: 'GET' });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/commercial_products_page_v2'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_offset: 0, p_limit: 20 });
    await new Promise(res => server.close(res));
    const otro = await servidor(['sourcing'], () => reply(200, {}));
    expect((await call(otro.server, '/api/administracion/BIZ-002/comercial/clientes', { token: 't', method: 'GET' })).status).toBe(403);
    await new Promise(res => otro.server.close(res));
  });
  test('the Gastos tab of a process: 20 at a time, only for that area', async () => {
    const filas = Array.from({ length: 21 }, (_, i) => ({ id: `EX-${i}` }));
    const { server, fetchImpl } = await servidor(['farm'], () => reply(200, filas));
    const r = await call(server, '/api/administracion/BIZ-002/gastos-area?area=farm&offset=20', { token: 't', method: 'GET' });
    expect(r.body.gastos).toHaveLength(20);
    expect(r.body.hayMas).toBe(true);
    const url = fetchImpl.mock.calls.find(c => c[0].includes('area_expenses_recent_v2'))[0];
    expect(url).toContain('area=eq.farm');
    expect(url).toContain('offset=20');
    expect(url).toContain('limit=21');
    expect((await call(server, '/api/administracion/BIZ-002/gastos-area?area=sourcing', { token: 't', method: 'GET' })).status).toBe(403);
    expect((await call(server, '/api/administracion/BIZ-002/gastos-area?area=x', { token: 't', method: 'GET' })).status).toBe(400);
    await new Promise(res => server.close(res));
  });
  test('the Logística report asks the database for a range of months; a bad month is refused before it', async () => {
    const { server, fetchImpl } = await servidor(['fulfillment'], () => reply(200, { meses: 2, franja: { creados: 3 } }));
    const r = await call(server, '/api/administracion/BIZ-002/logistica/reporte?desde=2026-05&hasta=2026-06', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ reporte: { meses: 2, franja: { creados: 3 } } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/logistics_report'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_from: '2026-05-01', p_to: '2026-06-30' });
    const n = fetchImpl.mock.calls.length;
    for (const q of ['desde=2026-13&hasta=2026-01', 'hasta=2026-05', '']) {
      expect((await call(server, `/api/administracion/BIZ-002/logistica/reporte?${q}`, { token: 't', method: 'GET' })).status).toBe(400);
    }
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });
  test('the Producción report asks the database for a range of months; a bad month is refused before it', async () => {
    const { server, fetchImpl } = await servidor(['production'], () => reply(200, { meses: 3, franja: { tuestes: 2 } }));
    const r = await call(server, '/api/administracion/BIZ-002/produccion/reporte?desde=2026-05&hasta=2026-07', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ reporte: { meses: 3, franja: { tuestes: 2 } } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/production_report_v3'))[1].body)) // v3: validated again with Production (4 Nov 2026)
      .toEqual({ p_business_id: 'farm-rosal', p_from: '2026-05-01', p_to: '2026-07-31' });
    const n = fetchImpl.mock.calls.length;
    for (const q of ['desde=2026-00&hasta=2026-01', 'desde=2026-05', '']) {
      expect((await call(server, `/api/administracion/BIZ-002/produccion/reporte?${q}`, { token: 't', method: 'GET' })).status).toBe(400);
    }
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });

  test('Finanzas lists a page of one tab, with hayMas; an unknown tab is refused before the database', async () => {
    const { server, fetchImpl } = await servidor(['finance'], () => reply(200, { total: 21, filas: [{ id: 'EX-1', estado: 'Urgente' }] }));
    const r = await call(server, '/api/administracion/BIZ-002/finanzas/lista?tipo=gastos&offset=20&limit=99', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ filas: [{ id: 'EX-1', estado: 'Urgente' }], total: 21, hayMas: false });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('finance_list_v2'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_kind: 'gastos', p_offset: 20, p_limit: 50 });
    const n = fetchImpl.mock.calls.length;
    expect((await call(server, '/api/administracion/BIZ-002/finanzas/lista?tipo=otro', { token: 't', method: 'GET' })).status).toBe(400);
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });
  test('Finanzas Movimientos asks the statement of the chosen account, a page at a time, with hayMas', async () => {
    const statement = { cuenta: { id: 'AC-02', nombre: 'Caja' }, cuentas: [{ id: 'AC-01' }, { id: 'AC-02' }], filas: [{ id: 'PY-1', monto: -10, saldo: 90 }], hay_mas: true };
    const { server, fetchImpl } = await servidor(['finance'], () => reply(200, statement));
    const r = await call(server, '/api/administracion/BIZ-002/finanzas/movimientos?cuenta=AC-02&offset=20&limit=99', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ ...statement, hayMas: true });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('finance_account_statement_page_v4'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_account: 'AC-02', p_offset: 20, p_limit: 50 });
    await call(server, '/api/administracion/BIZ-002/finanzas/movimientos', { token: 't', method: 'GET' });
    expect(JSON.parse(fetchImpl.mock.calls.filter(c => c[0].includes('finance_account_statement_page_v4')).pop()[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_account: null, p_offset: 0, p_limit: 20 });
    await new Promise(res => server.close(res));
  });
  test('a bank line opens its detail, and Conciliar sends the chosen record; bad input never reaches the database', async () => {
    const { server, fetchImpl } = await servidor(['finance'], () => reply(200, { id: 7, estado: 'Falta en la app', sugerencias: [] }));
    const d = await call(server, '/api/administracion/BIZ-002/finanzas/movimientos/7', { token: 't', method: 'GET' });
    expect(d.body).toEqual({ movimiento: { id: 7, estado: 'Falta en la app', sugerencias: [] } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('bank_movement_detail_v4'))[1].body)).toEqual({ p_business_id: 'farm-rosal', p_movement_id: 7 });
    const c = await call(server, '/api/administracion/BIZ-002/finanzas/movimientos/7/conciliar', { token: 't', method: 'POST', body: { tipo: 'gasto', ref: 'EX-0003', clientRef: 'conciliar-abc12345' } });
    expect(c.status).toBe(200);
    expect(JSON.parse(fetchImpl.mock.calls.find(x => x[0].includes('bank_match_confirm_v2'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_movement_id: 7, p_kind: 'gasto', p_ref: 'EX-0003', p_client_ref: 'conciliar-abc12345' });
    const n = fetchImpl.mock.calls.length;
    expect((await call(server, '/api/administracion/BIZ-002/finanzas/movimientos/abc', { token: 't', method: 'GET' })).status).toBe(400);
    expect((await call(server, '/api/administracion/BIZ-002/finanzas/movimientos/7/conciliar', { token: 't', method: 'POST', body: { tipo: 'otro', ref: 'x' } })).status).toBe(400);
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });
  test('a payment opens its detail, and the operation number goes to the database; bad input is refused first', async () => {
    const { server, fetchImpl } = await servidor(['finance'], () => reply(200, { id: 'PY-0008', estado: 'No está en el banco' }));
    const d = await call(server, '/api/administracion/BIZ-002/finanzas/pagos/PY-0008', { token: 't', method: 'GET' });
    expect(d.body).toEqual({ pago: { id: 'PY-0008', estado: 'No está en el banco' } });
    const o = await call(server, '/api/administracion/BIZ-002/finanzas/pagos/PY-0008/operacion', { token: 't', method: 'POST', body: { operacion: '6003252', clientRef: 'operacion-abc12345' } });
    expect(o.status).toBe(200);
    expect(JSON.parse(fetchImpl.mock.calls.find(x => x[0].includes('admin_set_payment_operation'))[1].body))
      .toEqual({ p_business_id: 'farm-rosal', p_payment_id: 'PY-0008', p_operation: '6003252', p_client_ref: 'operacion-abc12345' });
    const n = fetchImpl.mock.calls.length;
    expect((await call(server, '/api/administracion/BIZ-002/finanzas/pagos/x;drop', { token: 't', method: 'GET' })).status).toBe(400);
    expect((await call(server, '/api/administracion/BIZ-002/finanzas/pagos/PY-0008/operacion', { token: 't', method: 'POST', body: { operacion: 'sin numero' } })).status).toBe(400);
    expect(fetchImpl.mock.calls.length).toBe(n);
    await new Promise(res => server.close(res));
  });
  test('detail of one purchase', async () => {
    const { server, fetchImpl } = await servidor(['sourcing'], () => reply(200, { id: 'DL-1', agricultor: 'Agricultor Uno' }));
    const r = await call(server, '/api/administracion/BIZ-002/compras/DL-1', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ compra: { id: 'DL-1', agricultor: 'Agricultor Uno' } });
    expect(JSON.parse(fetchImpl.mock.calls.find(c => c[0].includes('purchase_detail_v4'))[1].body)).toEqual({ p_business_id: 'farm-rosal', p_delivery_id: 'DL-1' });
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

describe('Solicitar pago', () => {
  test('sends the amount and how it is paid; Finanzas confirms an advance payment by its request', () => {
    expect(FORMS.solicitarPago.fn).toBe('admin_request_purchase_payment_v2');
    expect(toParams(FORMS.solicitarPago, { compraId: 'PU-0001', monto: 300, metodo: 'advance', adelantoId: 'ADV-001', hack: 1 }, 'f'))
      .toEqual({ p_business_id: 'f', p_purchase_id: 'PU-0001', p_amount: 300, p_method: 'advance', p_advance_id: 'ADV-001' });
    expect(toParams(FORMS.pagoConAdelanto, { solicitudId: 7 }, 'f')).toEqual({ p_business_id: 'f', p_request_id: 7 });
  });

  test('prices never use advances by themselves; marking from advances is its own form', () => {
    expect(FORMS.precio.fn).toBe('admin_set_price_v3');
    expect(FORMS.pagoDesdeAdelantos.fn).toBe('admin_pay_purchase_from_advances');
    expect(toParams(FORMS.pagoDesdeAdelantos, { compraId: 'PU-0001', monto: 5 }, 'f')).toEqual({ p_business_id: 'f', p_purchase_id: 'PU-0001' });
  });
});

describe('Compras → Adelantos', () => {
  test('advances with names, requests waiting on the first page, only for the Compras area', async () => {
    const fetchImpl = jest.fn(async url => {
      if (url.includes('my_areas_v2')) return reply(200, [{ area: 'sourcing' }]);
      if (url.includes('/advance_balances?')) return reply(200, [{ id: 'ADV-002', party_id: 'P-1', open_balance: 200 }]);
      if (url.includes('/advance_requests_pending?')) return reply(200, [{ id: 'SOL-1', party: 'Misael', amount: 1500 }]);
      if (url.includes('/parties?')) return reply(200, [{ id: 'P-1', name: 'Agricultor Uno' }]);
      return reply(200, []);
    });
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/adelantos?limit=999', { token: 't', method: 'GET' });
    expect(r.body).toEqual({ porAprobar: [{ id: 'SOL-1', party: 'Misael', amount: 1500 }],
      adelantos: [{ id: 'ADV-002', party_id: 'P-1', open_balance: 200, nombre: 'Agricultor Uno' }], hayMas: false });
    expect(decodeURIComponent(fetchImpl.mock.calls.find(c => c[0].includes('/advance_balances?'))[0])).toContain('limit=50');
    const r2 = await call(server, '/api/administracion/BIZ-002/adelantos?offset=20', { token: 't', method: 'GET' });
    expect(r2.body.porAprobar).toEqual([]);
    await new Promise(res => server.close(res));
  });
  test('without the Compras area: 403', async () => {
    const fetchImpl = jest.fn(async () => reply(200, [{ area: 'production' }]));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    expect((await call(server, '/api/administracion/BIZ-002/adelantos', { token: 't', method: 'GET' })).status).toBe(403);
    expect(fetchImpl.mock.calls.some(c => c[0].includes('advance_balances'))).toBe(false);
    await new Promise(res => server.close(res));
  });
});

describe('provider detail', () => {
  test('asks party_detail with the person\'s own token', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { id: 'P-0001', nombre: 'Agricultor Uno' }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/proveedores/P-0001', { token: 'person-token', method: 'GET' });
    expect(r.body).toEqual({ proveedor: { id: 'P-0001', nombre: 'Agricultor Uno' } });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toContain('rpc/party_detail_v2');
    expect(opts.headers.Authorization).toBe('Bearer person-token');
    expect(JSON.parse(opts.body)).toEqual({ p_business_id: 'farm-rosal', p_party_id: 'P-0001' });
    await new Promise(res => server.close(res));
  });
});

describe('provider report and editing', () => {
  test('the report is read only when asked, with the person\'s token', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { nombre: 'Agricultor Uno', compras_lista: [] }));
    const app = express(); app.use(express.json());
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k',
    }));
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const r = await call(server, '/api/administracion/BIZ-002/proveedores/P-0001/reporte', { token: 'tk', method: 'GET' });
    expect(r.body.reporte.nombre).toBe('Agricultor Uno');
    expect(fetchImpl.mock.calls[0][0]).toContain('rpc/party_report');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tk');
    await new Promise(res => server.close(res));
  });
  test('edit forms map to the owner-only functions', () => {
    expect(toParams(FORMS.editarProveedor, { proveedorId: 'P-1', nombre: 'Ana', telefono: '999' }, 'f'))
      .toEqual({ p_business_id: 'f', p_party_id: 'P-1', p_name: 'Ana', p_phone: '999' });
    expect(toParams(FORMS.cuentaProveedor, { proveedorId: 'P-1', tipo: 'bank_account', numero: '000', reemplazaId: 7 }, 'f'))
      .toEqual({ p_business_id: 'f', p_party_id: 'P-1', p_kind: 'bank_account', p_number: '000', p_replace_id: 7 });
    expect(FORMS.quitarCuenta.fn).toBe('admin_archive_payment_method');
  });
});

describe('evidence', () => {
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
  async function servidor(fetchImpl, serviceKey = () => 'service') {
    const app = express(); app.use(express.json({ limit: '20mb' }));
    app.use('/api/administracion', createAdministracionRouter({
      getNegocio: () => ({ farmId: 'farm-rosal' }), verifyToken: async () => ({ uid: 'u' }), fetchImpl,
      supabaseUrl: () => 'https://db.example', publishableKey: () => 'k', serviceKey,
    }));
    return new Promise(r => { const s = app.listen(0, () => r(s)); });
  }
  const sube = (server, body) => call(server, '/api/administracion/BIZ-002/evidencias', { token: 'owner-token', method: 'POST', body });

  test('the database says yes first with the person\'s login, then the file is stored and recorded', async () => {
    const fetchImpl = jest.fn(async url => url.includes('evidence_folder') ? reply(200, 'farm-rosal/purchase/PU-0001/')
      : url.includes('/storage/') ? reply(200, { Key: 'x' }) : reply(200, { evidence_id: 1 }));
    const server = await servidor(fetchImpl);
    const r = await sube(server, { tipo: 'purchase', id: 'PU-0001', archivoBase64: `data:image/jpeg;base64,${JPG}`, nota: 'Voucher' });
    expect(r.status).toBe(200);
    const [carpeta, subida, registro] = fetchImpl.mock.calls;
    expect(carpeta[0]).toContain('rpc/evidence_folder');
    expect(carpeta[1].headers.Authorization).toBe('Bearer owner-token');
    expect(subida[0]).toMatch(/^https:\/\/db\.example\/storage\/v1\/object\/operations-evidence\/farm-rosal\/purchase\/PU-0001\/\d+-[0-9a-f]{8}\.jpg$/);
    expect(subida[1].headers.Authorization).toBe('Bearer service');
    expect(subida[1].headers['Content-Type']).toBe('image/jpeg');
    expect(registro[0]).toContain('rpc/admin_add_evidence');
    expect(registro[1].headers.Authorization).toBe('Bearer owner-token');
    expect(JSON.parse(registro[1].body)).toMatchObject({ p_kind: 'purchase', p_target_id: 'PU-0001', p_mime: 'image/jpeg', p_size: 8, p_note: 'Voucher' });
    await new Promise(res => server.close(res));
  });

  test('staff are refused by the database and nothing is stored', async () => {
    const fetchImpl = jest.fn(async () => reply(400, { message: 'Only the owners add evidence.' }));
    const server = await servidor(fetchImpl);
    const r = await sube(server, { tipo: 'expense', id: 'EX-0001', archivoBase64: JPG });
    expect(r).toEqual({ status: 400, body: { error: 'Only the owners add evidence.' } });
    expect(fetchImpl.mock.calls.some(c => c[0].includes('/storage/'))).toBe(false);
    await new Promise(res => server.close(res));
  });

  test('a file that is not a photo or a PDF, or an unknown record type, is refused before anything', async () => {
    const fetchImpl = jest.fn();
    const server = await servidor(fetchImpl);
    expect((await sube(server, { tipo: 'purchase', id: 'PU-1', archivoBase64: Buffer.from('MZ fake exe').toString('base64') })).status).toBe(400);
    expect((await sube(server, { tipo: 'orders', id: 'PU-1', archivoBase64: JPG })).status).toBe(400);
    expect((await sube(server, { tipo: 'purchase', id: '../x', archivoBase64: JPG })).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    await new Promise(res => server.close(res));
  });

  test('if recording fails, the stored file is removed', async () => {
    const fetchImpl = jest.fn(async (url, opts) => url.includes('evidence_folder') ? reply(200, 'farm-rosal/expense/EX-1/')
      : url.includes('admin_add_evidence') ? reply(400, { message: 'The file is not in the folder of that record.' }) : reply(200, {}));
    const server = await servidor(fetchImpl);
    const r = await sube(server, { tipo: 'expense', id: 'EX-1', archivoBase64: JPG });
    expect(r.status).toBe(400);
    const borrado = fetchImpl.mock.calls.find(c => c[1].method === 'DELETE');
    expect(borrado[0]).toBe('https://db.example/storage/v1/object/operations-evidence');
    await new Promise(res => server.close(res));
  });

  test('the list gives 10-minute links and never the storage path', async () => {
    const fetchImpl = jest.fn(async url => url.includes('evidence_of')
      ? reply(200, [{ id: 3, path: 'farm-rosal/purchase/PU-1/a.jpg', tipo: 'image/jpeg', nota: 'Voucher' }])
      : reply(200, [{ path: 'farm-rosal/purchase/PU-1/a.jpg', signedURL: '/object/sign/operations-evidence/farm-rosal/purchase/PU-1/a.jpg?token=t' }]));
    const server = await servidor(fetchImpl);
    const r = await call(server, '/api/administracion/BIZ-002/evidencias?tipo=purchase&id=PU-1', { token: 'owner-token', method: 'GET' });
    expect(r.body.evidencias).toEqual([{ id: 3, tipo: 'image/jpeg', nota: 'Voucher',
      url: 'https://db.example/storage/v1/object/sign/operations-evidence/farm-rosal/purchase/PU-1/a.jpg?token=t' }]);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ expiresIn: 600, paths: ['farm-rosal/purchase/PU-1/a.jpg'] });
    await new Promise(res => server.close(res));
  });

  test('Quitar evidencia archives it through the database', () => {
    expect(FORMS.quitarEvidencia.fn).toBe('admin_archive_evidence');
  });
});
