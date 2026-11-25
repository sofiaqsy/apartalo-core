// The green coffee of a product comes from its current lot (25 Nov 2026): Essential's own lot L-8 ran out and its
// compra opened L-9; Nuevo pedido must count L-9, not L-8.
jest.mock('axios');
const axios = require('axios');
const { currentGreenLots, getProductsWithPresentations } = require('../../core/services/supabase-service');

let db;
beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.example';
  db = {
    green_lot_growing: [{ product_id: 'blend', green_lot_id: 'L7', closes_on: null }],
    deliveries: [{ id: 'DL-22', business_id: 'f', linked_product_id: 'ess' }, { id: 'DL-23', business_id: 'f', linked_product_id: 'blend' }],
    green_lot_estimates: [
      { business_id: 'f', delivery_id: 'DL-22', green_lot_id: 'L9', created_at: '2026-11-23T22:06:56Z' },
      { business_id: 'f', delivery_id: 'DL-23', green_lot_id: 'L7', created_at: '2026-11-24T00:39:56Z' },
    ],
    green_lots: [
      { id: 'L7', current_kg: 1267.36, status: 'available' },
      { id: 'L8', current_kg: 0, status: 'available' },
      { id: 'L9', current_kg: 80, status: 'available' },
      { id: 'L2', current_kg: 195, status: 'available' },
    ],
  };
  axios.get.mockImplementation(async url => {
    const u = decodeURIComponent(url);
    const t = Object.keys(db).find(k => u.includes(`/rest/v1/${k}?`));
    if (t) return { data: db[t] };
    if (u.includes('/products?')) return { data: [{ id: 'ess', name: 'Essential', status: 'active', green_lot_id: 'L8' }] };
    if (u.includes('/product_presentations?')) return { data: [{ id: 'pv', product_id: 'ess', pack_size: 1, unit: 'kg', grind: ['green'], stock: 3 }] };
    return { data: [] };
  });
});

test('an empty own lot gives way to the newest lot from its compras', async () => {
  expect(await currentGreenLots([{ id: 'ess', green_lot_id: 'L8' }])).toEqual({ ess: { id: 'L9', current_kg: 80 } });
});

test('the growing lot comes first, and a product whose own lot has coffee keeps it', async () => {
  const r = await currentGreenLots([{ id: 'blend', green_lot_id: 'L7' }, { id: 'obata', green_lot_id: 'L2' }]);
  expect(r).toEqual({ blend: { id: 'L7', current_kg: 1267.36 }, obata: { id: 'L2', current_kg: 195 } });
});

test('with no lot with coffee it stays on its own lot (sold out)', async () => {
  db.green_lots.find(l => l.id === 'L9').current_kg = 0;
  expect(await currentGreenLots([{ id: 'ess', green_lot_id: 'L8' }])).toEqual({ ess: { id: 'L8', current_kg: 0 } });
});

test('Nuevo pedido: Essential green 1 kg shows the 80 kg of L-9 as stock', async () => {
  const [p] = await getProductsWithPresentations('f');
  expect(p.presentations[0].stock).toBe(80);
});
