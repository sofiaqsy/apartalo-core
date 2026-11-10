const { createPushPorArea } = require('../../core/services/push-por-area');

function reply(status, body) {
  return { ok: status < 300, status, text: async () => JSON.stringify(body) };
}

describe('push por área (10 Nov 2026)', () => {
  const evento = {
    clave: 'order:1', area: 'commercial', titulo: 'Nuevo pedido', texto: 'ORD-69 · Cafe Prueba · S/ 45.00',
    datos: { type: 'nuevo_pedido', pedidoId: 'o1', numero: 'ORD-69' }, tokens: ['tok-ok', 'tok-muerto'],
  };

  function armar(eventos) {
    const fetchImpl = jest.fn(async url => reply(200, url.endsWith('push_events_claim_v2') ? eventos : true));
    const sendEachForMulticast = jest.fn(async () => ({
      successCount: 1,
      responses: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered' } }],
    }));
    const push = createPushPorArea({
      negocios: () => [{ id: 'BIZ-002', farmId: 'farm-rosal' }, { id: 'BIZ-001' }], // only businesses linked to fincas
      messaging: () => ({ sendEachForMulticast }),
      fetchImpl,
      supabaseUrl: () => 'https://db.example',
      serviceKey: () => 'service',
      log: { log: () => {}, error: () => {} },
    });
    return { push, fetchImpl, sendEachForMulticast };
  }

  test('each new event goes to the phones of its area, with the service key, and a dead phone is removed', async () => {
    const { push, fetchImpl, sendEachForMulticast } = armar([evento]);
    expect(await push.revisar()).toEqual({ eventos: 1, enviados: 1 });
    const claims = fetchImpl.mock.calls.filter(c => c[0].endsWith('rpc/push_events_claim_v2'));
    expect(claims).toHaveLength(1);
    expect(JSON.parse(claims[0][1].body)).toEqual({ p_business_id: 'farm-rosal' });
    expect(claims[0][1].headers.Authorization).toBe('Bearer service');
    const msg = sendEachForMulticast.mock.calls[0][0];
    expect(msg.tokens).toEqual(['tok-ok', 'tok-muerto']);
    expect(msg.notification).toEqual({ title: 'Nuevo pedido', body: 'ORD-69 · Cafe Prueba · S/ 45.00' });
    expect(msg.data).toEqual({ type: 'nuevo_pedido', pedidoId: 'o1', numero: 'ORD-69', area: 'commercial' });
    const quitar = fetchImpl.mock.calls.filter(c => c[0].endsWith('rpc/push_unregister_device'));
    expect(quitar.map(c => JSON.parse(c[1].body))).toEqual([{ p_token: 'tok-muerto' }]);
  });

  test('an event with no phone (nobody has the area) sends nothing', async () => {
    const { push, sendEachForMulticast } = armar([{ ...evento, tokens: [] }]);
    expect(await push.revisar()).toEqual({ eventos: 1, enviados: 0 });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  test('without Firebase or the service key, nothing is asked', async () => {
    const fetchImpl = jest.fn();
    const push = createPushPorArea({ negocios: () => [{ farmId: 'f' }], messaging: () => null, fetchImpl, supabaseUrl: () => 'x', serviceKey: () => 'k' });
    expect(await push.revisar()).toEqual({ eventos: 0, enviados: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
