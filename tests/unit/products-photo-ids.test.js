// getProductsWithPresentations gives each presentation its photos with their ids, so an outside app can remove one
// (DELETE .../photos/:photoId). Asked by the General Manager, 23 Nov 2026.
jest.mock('axios');
const axios = require('axios');
const { getProductsWithPresentations } = require('../../core/services/supabase-service');

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.example';
  axios.get.mockImplementation(async url => {
    if (url.includes('/products?')) return { data: [{ id: 'p1', name: 'Blend', status: 'active' }] };
    if (url.includes('/product_presentations?')) return { data: [
      { id: 'pp1', product_id: 'p1', pack_size: 1, unit: 'kg', price_cents: 9000, stock: 2 },
      { id: 'pp2', product_id: 'p1', pack_size: 250, unit: 'g', price_cents: 2500, stock: 3 },
    ] };
    if (url.includes('/media?')) {
      expect(decodeURIComponent(url)).toMatch(/select=id,/);
      return { data: [
        { id: 'm1', owner_id: 'p1', presentation_id: 'pp1', url: 'https://x/1.jpg', sort_order: 0 },
        { id: 'm2', owner_id: 'p1', presentation_id: 'pp1', url: 'https://x/2.jpg', sort_order: 1 },
        { id: 'm3', owner_id: 'p1', presentation_id: null, role: 'cover', url: 'https://x/c.jpg', sort_order: 0 },
      ] };
    }
    return { data: [] };
  });
});

test('each presentation lists its photos with id and url', async () => {
  const [p] = await getProductsWithPresentations('farm');
  const kilo = p.presentations.find(x => x.id === 'pp1');
  expect(kilo.fotos.map(f => [f.id, f.url])).toEqual([['m1', 'https://x/1.jpg'], ['m2', 'https://x/2.jpg']]);
  expect(kilo.image_url).toBe('https://x/1.jpg');
});

test('a presentation without photos gets an empty list', async () => {
  const [p] = await getProductsWithPresentations('farm');
  expect(p.presentations.find(x => x.id === 'pp2').fotos).toEqual([]);
});
