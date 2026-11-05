// Client detail → Pedidos and the client's PDF report (General Manager, 5 Nov 2026).
jest.mock('../../core/services/supabase-service');
jest.mock('../../config/negocios', () => ({ getById: id => (id === 'BIZ-002' ? { farmId: 'farm-rosal' } : null) }));
jest.mock('../../core/services/whatsapp-service', () => ({}));
const http = require('http');
const express = require('express');
const supabaseService = require('../../core/services/supabase-service');
const router = require('../../routes/clientes-router');

const ID = '11111111-2222-3333-4444-555555555555';
function get(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    }).on('error', reject);
  });
}

// Orders as getOrdersByFarm maps them (oldest first when asked with orden=antiguos).
const pedido = (n, creado, estado, total, pagos = [], extra = {}) => ({
  id: `ORD-${n}`, estado, total, pagos, evidencias: [], tracking: { creadoEn: creado }, fechaCompletado: null, ...extra,
});
const PEDIDOS = [
  pedido(1, '2026-09-30T23:30:00-05:00', 'COMPLETADO', 800, [{ id: 'p1', monto: 800, fecha: '2026-10-01T15:00:00Z' }],
    { fechaCompletado: '2026-10-02T17:00:00Z', evidencias: [{ paymentId: 'p1', verificacion: { operacionBCP: '06090112' } }] }),
  pedido(2, '2026-10-12T10:00:00-05:00', 'COMPLETADO', 4800,
    [{ id: 'p2', monto: 2400, fecha: '2026-10-13T01:40:00Z' }, { id: 'p3', monto: 2400, fecha: '2026-11-04T03:32:00Z' }],
    { fechaCompletado: '2026-11-04T20:00:00Z', evidencias: [{ paymentId: 'p3', verificacion: { operacionBCP: '7396343' } }, { paymentId: 'p2', verificacion: null }] }),
  pedido(3, '2026-10-20T09:00:00-05:00', 'CONFIRMADO', 500, [{ id: 'p4', monto: 200, fecha: '2026-10-21T15:00:00Z' }]),
  pedido(4, '2026-10-25T09:00:00-05:00', 'CANCELADO', 300),
  pedido(5, '2026-11-02T09:00:00-05:00', 'PENDIENTE', 100),
];

describe('client orders and report', () => {
  let server;
  beforeAll(done => {
    const app = express();
    app.use('/api/clientes', router);
    server = app.listen(0, done);
  });
  afterAll(done => server.close(done));
  beforeEach(() => {
    supabaseService.getCustomerById.mockResolvedValue({ id: ID, phone: '+51 999 888 777', business_name: 'Café Cirilo' });
    supabaseService.getOrdersByFarm.mockImplementation(async (farm, f) => ({ pedidos: f.orden === 'antiguos' ? PEDIDOS : [...PEDIDOS].reverse() }));
  });

  test('the customer orders come 20 at a time, newest first, asked by the customer id and phone', async () => {
    const r = await get(server, `/api/clientes/BIZ-002/${ID}/pedidos?offset=1&limit=2`);
    expect(r.status).toBe(200);
    expect(r.body.pedidos.map(p => p.id)).toEqual(['ORD-4', 'ORD-3']);
    expect(r.body).toMatchObject({ total: 5, hayMas: true });
    expect(supabaseService.getOrdersByFarm).toHaveBeenCalledWith('farm-rosal', expect.objectContaining({ comprador: { id: ID, telefono: '+51 999 888 777' } }));
    expect((await get(server, '/api/clientes/BIZ-002/no-uuid/pedidos')).status).toBe(400);
  });

  test('the report: orders registered in the months (Lima time), cancelled marked, paid or partly, payment days and operation numbers', async () => {
    const r = await get(server, `/api/clientes/BIZ-002/${ID}/reporte?desde=2026-10&hasta=2026-10`);
    expect(r.status).toBe(200);
    const rep = r.body.reporte;
    expect(rep).toMatchObject({ cliente: 'Café Cirilo', desde: '2026-10-01', hasta: '2026-10-31', meses: 1, anual: false });
    // ORD-1 was registered on 30 Sep in Lima (its UTC day is 1 Oct): not in October. ORD-5 is November.
    expect(rep.pedidos.map(p => p.pedido)).toEqual(['ORD-2', 'ORD-3', 'ORD-4']);
    expect(rep.pedidos[0]).toMatchObject({
      registrado: '2026-10-12', estado: 'COMPLETADO', pago: 'Pagado', total: 4800, pagado: 4800, debe: 0, completado: '2026-11-04',
      pagos: [{ fecha: '2026-10-12', monto: 2400, operacion: null }, { fecha: '2026-11-03', monto: 2400, operacion: '7396343' }],
    });
    expect(rep.pedidos[1]).toMatchObject({ pago: 'Parcial', pagado: 200, debe: 300, completado: null });
    expect(rep.pedidos[2]).toMatchObject({ estado: 'CANCELADO', pago: 'Sin pagar', debe: 0 });
    // Cancelled orders are counted apart and never add to what is owed.
    expect(rep.franja).toEqual({ pedidos: 3, cancelados: 1, total: 5300, pagado: 5000, debe: 300 });
  });

  test('the report checks the months like Administración: at most 12, Hasta after Desde', async () => {
    expect((await get(server, `/api/clientes/BIZ-002/${ID}/reporte?desde=2026-01&hasta=2026-12`)).body.reporte.anual).toBe(true);
    expect((await get(server, `/api/clientes/BIZ-002/${ID}/reporte?desde=2025-11&hasta=2026-11`)).status).toBe(400);
    expect((await get(server, `/api/clientes/BIZ-002/${ID}/reporte?desde=2026-11&hasta=2026-10`)).status).toBe(400);
    expect((await get(server, `/api/clientes/BIZ-002/${ID}/reporte?desde=2026-13&hasta=2026-12`)).status).toBe(400);
  });

  test('the detail looks at all of the customer orders, not only the farm 50 newest', async () => {
    const r = await get(server, `/api/clientes/BIZ-002/${ID}`);
    expect(r.status).toBe(200);
    expect(supabaseService.getOrdersByFarm).toHaveBeenCalledWith('farm-rosal', expect.objectContaining({ comprador: { id: ID, telefono: '+51 999 888 777' } }));
  });
});
