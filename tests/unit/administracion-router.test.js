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
