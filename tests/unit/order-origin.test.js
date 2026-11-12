const { createOrderOrigin } = require('../../core/services/order-origin');

describe('who created each pedido (11 Nov 2026)', () => {
  const quiet = { log: () => {}, error: () => {} };

  test('the person comes from the login; only a verified email is kept; no or bad login gives nothing', async () => {
    const verifyToken = jest.fn(async t => {
      if (t === 'bueno') return { uid: 'u1', email: 'obed@x.com', emailVerified: true, name: 'Obed' };
      if (t === 'sin-verificar') return { uid: 'u2', email: 'x@x.com', emailVerified: false, name: null };
      throw new Error('invalid');
    });
    const o = createOrderOrigin({ rpc: jest.fn(), verifyToken, log: quiet });
    const req = t => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
    expect(await o.persona(req('bueno'))).toEqual({ uid: 'u1', email: 'obed@x.com', nombre: 'Obed' });
    expect(await o.persona(req('sin-verificar'))).toEqual({ uid: 'u2', email: null, nombre: null });
    expect(await o.persona(req('malo'))).toEqual({});
    expect(await o.persona(req(null))).toEqual({});
  });

  test('records with the database function, and a failure never throws', async () => {
    const rpc = jest.fn(async () => true);
    const o = createOrderOrigin({ rpc, log: quiet });
    expect(await o.registrar('ord-1', 'app', { uid: 'u1', email: 'obed@x.com', nombre: 'Obed' })).toBe(true);
    expect(rpc).toHaveBeenCalledWith('order_origin_record',
      { p_order_id: 'ord-1', p_origen: 'app', p_uid: 'u1', p_email: 'obed@x.com', p_nombre: 'Obed' });
    expect(await o.registrar('ord-2', 'whatsapp')).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith('order_origin_record',
      { p_order_id: 'ord-2', p_origen: 'whatsapp', p_uid: null, p_email: null, p_nombre: null });
    const falla = createOrderOrigin({ rpc: async () => { throw new Error('db down'); }, log: quiet });
    expect(await falla.registrar('ord-3', 'app')).toBe(false);
  });

  test('reads it back; older pedidos and errors give null', async () => {
    const o = createOrderOrigin({ rpc: async (fn, b) => (b.p_order_id === 'ord-1' ? { origen: 'app', nombre: 'Obed' } : null), log: quiet });
    expect(await o.de('ord-1')).toEqual({ origen: 'app', nombre: 'Obed' });
    expect(await o.de('ord-viejo')).toBeNull();
    expect(await createOrderOrigin({ rpc: async () => { throw new Error('x'); } }).de('ord-1')).toBeNull();
  });
});
