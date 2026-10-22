const { createProductInfo, buildUpdate, toApi, InfoError, LIMITS } = require('../../core/services/product-info');

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROD = U(1);
const CATS = [{ id: U(10), name: 'Café' }, { id: U(11), name: 'Cacao' }];
const VARS = [{ id: U(20), name: 'Obata' }, { id: U(21), name: 'Caturra' }];
const ROASTS = [{ id: U(30), name: 'Claro' }];
const PROCS = [{ id: U(40), name: 'Lavado' }];
const DRYS = [{ id: U(50), name: 'Secado al sol' }];
const NOTES = [{ id: U(60), name: 'Chocolate' }, { id: U(61), name: 'Cítricos' }];

function build() {
  const db = {
    products: [{ id: PROD, name: 'Obata', description: null, detail: null, category_id: U(10), variety_id: U(20), roast_level_id: U(30),
      process_method_id: U(40), drying_method_id: U(50), sensory_notes: ['Chocolate'], nutrition_facts: 'secret', slug: 'obata' }],
    product_categories: CATS, coffee_varieties: VARS, coffee_roast_levels: ROASTS, coffee_process_methods: PROCS,
    coffee_drying_methods: DRYS, coffee_sensory_notes: NOTES,
  };
  const get = jest.fn(async (t, p = {}) => db[t].filter(r => !p.id || r.id === String(p.id).replace('eq.', '')));
  const patch = jest.fn(async (t, p, fields) => { const rows = db[t].filter(r => r.id === String(p.id).replace('eq.', '')); rows.forEach(r => Object.assign(r, fields)); return rows; });
  return { svc: createProductInfo({ get, patch }), get, patch, db };
}
const catalogs = { categorias: CATS, variedades: VARS, tuestes: ROASTS, procesos: PROCS, secados: DRYS };
const expectErr = async (p, status, field) => {
  await expect(p).rejects.toBeInstanceOf(InfoError);
  await p.catch(e => { expect(e.status).toBe(status); if (field) expect(e.field).toBe(field); });
};

describe('toApi', () => {
  test('maps columns to the Spanish API fields and never exposes slug or nutrition facts', () => {
    const api = toApi({ id: 'x', name: 'Obata', description: 'Breve', detail: 'Largo', category_id: U(10), variety_id: U(20), roast_level_id: U(30),
      process_method_id: U(40), drying_method_id: U(50), sensory_notes: ['Chocolate'], slug: 'obata', nutrition_facts: 'secret' });
    expect(api).toEqual({ id: 'x', nombre: 'Obata', descripcionBreve: 'Breve', detalle: 'Largo', categoriaId: U(10), variedadId: U(20), tuesteId: U(30),
      procesoId: U(40), secadoId: U(50), notasSensoriales: ['Chocolate'] });
  });
  test('nulls become empty text and empty lists', () => {
    const api = toApi({ id: 'x', name: 'A', description: null, detail: null, sensory_notes: null });
    expect(api).toMatchObject({ descripcionBreve: '', detalle: '', categoriaId: null, notasSensoriales: [] });
  });
});

describe('buildUpdate', () => {
  test('maps fields to columns and trims text', () => {
    expect(buildUpdate({ nombre: '  Obata  ', descripcionBreve: ' Resumen ', detalle: 'Historia', variedadId: U(21) }, catalogs))
      .toEqual({ name: 'Obata', description: 'Resumen', detail: 'Historia', variety_id: U(21) });
  });
  test('empty text clears description and detail (stored as null)', () => {
    expect(buildUpdate({ descripcionBreve: '   ', detalle: '' }, catalogs)).toEqual({ description: null, detail: null });
  });
  test('null or empty id clears the option', () => {
    expect(buildUpdate({ tuesteId: null, procesoId: '' }, catalogs)).toEqual({ roast_level_id: null, process_method_id: null });
  });
  test('only known fields are read: slug, nutrition facts, farm, price and status are ignored', () => {
    const f = buildUpdate({ slug: 'hack', nutritionFacts: 'x', nutrition_facts: 'x', farm_id: U(99), price_cents: 1, status: 'active', nombre: 'Ok' }, catalogs);
    expect(f).toEqual({ name: 'Ok' });
  });
  test.each([
    ['empty name', { nombre: '   ' }, 'nombre'],
    ['name too long', { nombre: 'x'.repeat(LIMITS.nombre + 1) }, 'nombre'],
    ['description too long', { descripcionBreve: 'x'.repeat(LIMITS.descripcionBreve + 1) }, 'descripcionBreve'],
    ['detail too long', { detalle: 'x'.repeat(LIMITS.detalle + 1) }, 'detalle'],
    ['name not a string', { nombre: 5 }, 'nombre'],
    ['unknown option id', { variedadId: U(999) }, 'variedadId'],
    ['option from another catalog', { variedadId: U(30) }, 'variedadId'], // a roast id used as a variety
    ['malformed id', { categoriaId: 'abc' }, 'categoriaId'],
    ['notes not a list', { notasSensoriales: 'Chocolate' }, 'notasSensoriales'],
    ['note too long', { notasSensoriales: ['x'.repeat(LIMITS.notaLargo + 1)] }, 'notasSensoriales'],
    ['too many notes', { notasSensoriales: Array.from({ length: LIMITS.notas + 1 }, (_, i) => `n${i}`) }, 'notasSensoriales'],
    ['note not text', { notasSensoriales: [1] }, 'notasSensoriales'],
  ])('%s -> 400', (_l, body, field) => {
    expect(() => buildUpdate(body, catalogs)).toThrow(InfoError);
    try { buildUpdate(body, catalogs); } catch (e) { expect(e.status).toBe(400); expect(e.field).toBe(field); }
  });
  test('notes are trimmed, deduplicated ignoring case, and empty ones dropped; free text is allowed', () => {
    expect(buildUpdate({ notasSensoriales: [' Chocolate ', 'chocolate', '', 'Mi nota propia'] }, catalogs)).toEqual({ sensory_notes: ['Chocolate', 'Mi nota propia'] });
  });
});

describe('service', () => {
  test('getInfo returns the product and the catalogs for the pickers', async () => {
    const { svc } = build();
    const r = await svc.getInfo(PROD);
    expect(r.producto).toMatchObject({ id: PROD, nombre: 'Obata', variedadId: U(20), notasSensoriales: ['Chocolate'] });
    expect(r.producto).not.toHaveProperty('slug');
    expect(r.producto).not.toHaveProperty('nutrition_facts');
    expect(r.catalogos.categorias).toEqual([{ id: U(10), nombre: 'Café' }, { id: U(11), nombre: 'Cacao' }]);
    expect(r.catalogos.variedades.map(v => v.nombre)).toEqual(['Obata', 'Caturra']);
    expect(r.catalogos.notasSugeridas).toEqual(['Chocolate', 'Cítricos']);
  });
  test('malformed or unknown product id -> 404 without touching the products table for the malformed one', async () => {
    const { svc, get } = build();
    await expectErr(svc.getInfo('PROD-123'), 404);
    expect(get).not.toHaveBeenCalled();
    await expectErr(svc.getInfo(U(777)), 404);
  });
  test('updateInfo saves only the sent fields and returns the new state', async () => {
    const { svc, patch, db } = build();
    const r = await svc.updateInfo(PROD, { descripcionBreve: 'Resumen', variedadId: U(21), notasSensoriales: ['Cítricos'] });
    expect(patch).toHaveBeenCalledWith('products', { id: `eq.${PROD}` }, { description: 'Resumen', variety_id: U(21), sensory_notes: ['Cítricos'] });
    expect(r).toMatchObject({ descripcionBreve: 'Resumen', variedadId: U(21), notasSensoriales: ['Cítricos'] });
    expect(db.products[0].nutrition_facts).toBe('secret'); // untouched
    expect(db.products[0].slug).toBe('obata');
  });
  test('an invalid update writes nothing', async () => {
    const { svc, patch } = build();
    await expectErr(svc.updateInfo(PROD, { variedadId: U(999) }), 400, 'variedadId');
    expect(patch).not.toHaveBeenCalled();
  });
  test('an empty body is refused', async () => {
    await expectErr(build().svc.updateInfo(PROD, {}), 400);
    await expectErr(build().svc.updateInfo(PROD, { slug: 'x' }), 400);
  });
  test('catalogs are only loaded when an option id is being set', async () => {
    const { svc, get } = build();
    await svc.updateInfo(PROD, { nombre: 'Otro' });
    expect(get).not.toHaveBeenCalledWith('coffee_varieties', expect.anything());
  });
  test('updating a product that does not exist -> 404', async () => {
    await expectErr(build().svc.updateInfo(U(777), { nombre: 'X' }), 404);
  });
});
