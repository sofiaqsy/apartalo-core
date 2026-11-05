// getOrdersByFarm: the newest first as always, and the oldest first with orden=antiguos (Logística, Por despachar,
// General Manager 4 Nov 2026), page by page.
jest.mock('axios');
const axios = require('axios');
const { getOrdersByFarm } = require('../../core/services/supabase-service');

const pedido = (id, dia, status) => ({
  id, order_number: `ORD-${id}`, status, created_at: `2026-11-0${dia}T10:00:00Z`, notes: '', customer_name: `Cliente ${id}`,
});

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.example';
  axios.get.mockImplementation(async url => {
    if (url.includes('/order_items?farm_id=')) return { data: [{ order_id: 'a' }, { order_id: 'b' }, { order_id: 'c' }] };
    // The database sends the orders newest first.
    if (url.includes('/orders?')) {
      // Like the database: only the orders in id=in.(...).
      const pedidas = decodeURIComponent(url).match(/id=in\.\(([^)]*)\)/)[1].split(',');
      return { data: [pedido('c', 3, 'pending'), pedido('b', 2, 'confirmed'), pedido('a', 1, 'pending')].filter(o => pedidas.includes(o.id)) };
    }
    return { data: [] };
  });
});

test('orders come newest first as always', async () => {
  const r = await getOrdersByFarm('farm', { vista: 'PENDIENTES', pagina: 1, limite: 20 });
  expect(r.pedidos.map(p => p.id)).toEqual(['ORD-c', 'ORD-b', 'ORD-a']);
});

test('orden=antiguos gives the oldest first, and pages keep that order', async () => {
  const p1 = await getOrdersByFarm('farm', { vista: 'PENDIENTES', pagina: 1, limite: 2, orden: 'antiguos' });
  const p2 = await getOrdersByFarm('farm', { vista: 'PENDIENTES', pagina: 2, limite: 2, orden: 'antiguos' });
  expect([...p1.pedidos, ...p2.pedidos].map(p => p.id)).toEqual(['ORD-a', 'ORD-b', 'ORD-c']);
  expect(p1.hayMas).toBe(true);
  expect(p2.hayMas).toBe(false);
});

test('ids: only those orders, and only if they are of this farm (Comercialización, Últimos pagos)', async () => {
  const r = await getOrdersByFarm('farm', { ids: ['b', 'z'], limite: 2 });
  expect(r.pedidos.map(p => p.id)).toEqual(['ORD-b']);
  const vacio = await getOrdersByFarm('farm', { ids: ['z'] });
  expect(vacio.pedidos).toEqual([]);
});

test('comprador: one customer orders, by their id or, for older orders, by the same phone digits', async () => {
  axios.get.mockImplementation(async url => {
    if (url.includes('/order_items?farm_id=')) return { data: [{ order_id: 'a' }, { order_id: 'b' }, { order_id: 'c' }] };
    if (url.includes('/orders?')) {
      return { data: [
        { ...pedido('c', 3, 'pending'), customer_id: 'u-1', customer_phone: '' },
        { ...pedido('b', 2, 'pending'), customer_id: null, customer_phone: '51 999-888-777' },
        { ...pedido('a', 1, 'pending'), customer_id: 'u-2', customer_phone: '+51 111' },
      ] };
    }
    return { data: [] };
  });
  const r = await getOrdersByFarm('farm', { comprador: { id: 'u-1', telefono: '+51 999 888 777' } });
  expect(r.pedidos.map(p => p.id)).toEqual(['ORD-c', 'ORD-b']);
});
