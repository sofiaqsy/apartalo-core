const { createClientesAcceso } = require('../../core/services/clientes-acceso');

describe('Clientes only for members, a seller only his (17 Nov 2026)', () => {
  function reply(status, body) {
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  }
  function res() {
    const r = { statusCode: 200, body: null };
    r.status = c => { r.statusCode = c; return r; };
    r.json = b => { r.body = b; return r; };
    return r;
  }
  const negocios = { 'BIZ-002': { farmId: 'farm-rosal' }, 'BIZ-SIN': { id: 'BIZ-SIN' } };

  function acceso(respuestas) {
    const fetchImpl = jest.fn(async (url, opts) => {
      const fn = url.split('/rpc/')[1];
      return reply(200, typeof respuestas[fn] === 'function' ? respuestas[fn](JSON.parse(opts.body)) : respuestas[fn]);
    });
    const a = createClientesAcceso({ getNegocio: id => negocios[id] || null, fetchImpl, supabaseUrl: () => 'https://db.example', publishableKey: () => 'pk' });
    return { a, fetchImpl };
  }

  test('without a login: 401, and nothing is asked', async () => {
    const { a, fetchImpl } = acceso({});
    const r = res(); const next = jest.fn();
    await a.acceso({ params: { businessId: 'BIZ-002' }, headers: {} }, r, next);
    expect(r.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a person of another business: 403', async () => {
    const { a, fetchImpl } = acceso({ farm_customer_access: { miembro: false, ve_todos: false } });
    const r = res(); const next = jest.fn();
    await a.acceso({ params: { businessId: 'BIZ-002' }, headers: { authorization: 'Bearer otro' } }, r, next);
    expect(r.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://db.example/rest/v1/rpc/farm_customer_access');
    expect(opts.headers.Authorization).toBe('Bearer otro'); // the person's own login, never a service key
    expect(JSON.parse(opts.body)).toEqual({ p_business_id: 'farm-rosal' });
  });

  test('a business not linked to fincas: 403; unknown: 404', async () => {
    const { a } = acceso({});
    const r1 = res(); await a.acceso({ params: { businessId: 'BIZ-SIN' }, headers: { authorization: 'Bearer t' } }, r1, jest.fn());
    expect(r1.statusCode).toBe(403);
    const r2 = res(); await a.acceso({ params: { businessId: 'BIZ-X' }, headers: { authorization: 'Bearer t' } }, r2, jest.fn());
    expect(r2.statusCode).toBe(404);
  });

  test('a member goes on; a client he may not see is not found, one he may is shown', async () => {
    const { a } = acceso({
      farm_customer_access: { miembro: true, ve_todos: false },
      farm_customer_visible: b => b.p_customer_id === '00000000-0000-0000-0000-000000000001',
    });
    const req = { params: { businessId: 'BIZ-002' }, headers: { authorization: 'Bearer vendedor' } };
    const next = jest.fn();
    await a.acceso(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(req.clientes.veTodos).toBe(false);

    const suyo = jest.fn();
    await a.visible(req, res(), suyo, '00000000-0000-0000-0000-000000000001');
    expect(suyo).toHaveBeenCalled();

    const r = res(); const ajeno = jest.fn();
    await a.visible(req, r, ajeno, '00000000-0000-0000-0000-000000000002');
    expect(ajeno).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(404);

    // A guest (no account) only for who sees all.
    const rg = res(); const invitado = jest.fn();
    await a.visible(req, rg, invitado, 'guest:999000000');
    expect(invitado).not.toHaveBeenCalled();
    expect(rg.statusCode).toBe(404);
  });
});
