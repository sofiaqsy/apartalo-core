const http = require('http');
const express = require('express');
const { createAdministracionRouter, toParams, FORMS } = require('../../routes/administracion-router');

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
    expect(Object.keys(FORMS).sort()).toEqual(['adelanto', 'aprobarAdelanto', 'entrega', 'gasto', 'ingreso', 'pago', 'pagoGasto', 'precio', 'proveedor', 'rechazarAdelanto', 'retiro']);
  });
  test('a form forwards the person\'s own token (never a service key) and only allowed fields', async () => {
    fetchImpl.mockResolvedValue(reply(200, { expense_id: 'EX-0001', payment_id: 'PY-0001' }));
    const r = await call(server, '/api/administracion/BIZ-002/registrar/gasto', {
      token: 'person-token',
      body: { categoria: 'Transporte', centro: 'coffee', monto: 80, metodo: 'transfer', operacion: ' 222222 ', descripcion: ' Flete ', clientRef: 'exp-0001-abcd', p_business_id: 'other-farm', hack: 'x' },
    });
    expect(r).toEqual({ status: 200, body: { ok: true, result: { expense_id: 'EX-0001', payment_id: 'PY-0001' } } });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://db.example/rest/v1/rpc/admin_request_expense_v2');
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
    expect(Object.keys(r.body).sort()).toEqual(['adelantos', 'adelantosPorAprobar', 'banco', 'gastosPorPagar', 'porPagar', 'sinPrecio']);
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
    expect(r.body.meses[0].url).toContain('area=eq.fulfillment');
    expect(r.body.gastos[0].url).toContain('/area_expenses_recent?');
    await new Promise(res => server.close(res));
  });

  test('the gasto sends the chosen area and links', () => {
    expect(toParams(FORMS.gasto, { categoria: 'Flete', monto: 85, area: 'fulfillment', envioId: 'SH-0001' }, 'f'))
      .toEqual({ p_business_id: 'f', p_category: 'Flete', p_amount: 85, p_area: 'fulfillment', p_shipment_id: 'SH-0001' });
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
