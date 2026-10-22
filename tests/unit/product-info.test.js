const { createProductInfo, buildUpdate, toApi, InfoError, LIMITS } = require('../../core/services/product-info');

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROD = U(1);
const CATS = [{ id: U(10), name: 'Café' }, { id: U(11), name: 'Cacao' }];
const VARS = [{ id: U(20), name: 'Obata' }, { id: U(21), name: 'Caturra' }];
const ROASTS = [{ id: U(30), name: 'Claro' }];
const PROCS = [{ id: U(40), name: 'Lavado' }];
const DRYS = [{ id: U(50), name: 'Secado al sol' }];
const NOTES = [{ id: U(60), name: 'Chocolate' }, { id: U(61), name: 'Cítricos' }];
const FARM = U(500), OTHER_FARM = U(501), SOURCE_FARM = U(502);
const CURRENCIES = [{ code: 'PEN', name: 'Sol peruano', symbol: 'S/.', is_active: true }, { code: 'USD', name: 'Dólar estadounidense', symbol: '$', is_active: true }, { code: 'XXX', name: 'Inactiva', symbol: '?', is_active: false }];
const LOTS = [
  { id: U(70), roastery_farm_id: FARM, status: 'available', lot_code: 'L-2', variety_id: U(20), source_farm_id: SOURCE_FARM, harvest_year: 2026, current_kg: '195', blend_varieties: [], created_at: 1 },
  { id: U(71), roastery_farm_id: FARM, status: 'available', lot_code: 'L-3', variety_id: null, source_farm_id: null, harvest_year: 2025, current_kg: '10.5', blend_varieties: ['Caturra', 'Obata'], created_at: 2 },
  { id: U(72), roastery_farm_id: FARM, status: 'depleted', lot_code: 'L-1', variety_id: U(21), source_farm_id: SOURCE_FARM, harvest_year: 2024, current_kg: '0', blend_varieties: [], created_at: 0 },
  { id: U(73), roastery_farm_id: OTHER_FARM, status: 'available', lot_code: 'X-1', variety_id: U(20), source_farm_id: null, harvest_year: 2026, current_kg: '50', blend_varieties: [], created_at: 3 },
];

function build() {
  const db = {
    products: [{ id: PROD, farm_id: FARM, manual_stock: false, currency: 'PEN', green_lot_id: null, name: 'Obata', description: null, detail: null, category_id: U(10), variety_id: U(20), roast_level_id: U(30),
      process_method_id: U(40), drying_method_id: U(50), sensory_notes: ['Chocolate'], nutrition_facts: 'secret', slug: 'obata' }],
    product_categories: CATS, coffee_varieties: VARS, coffee_roast_levels: ROASTS, coffee_process_methods: PROCS,
    coffee_drying_methods: DRYS, coffee_sensory_notes: NOTES,
    currencies: CURRENCIES, green_lots: LOTS, farms: [{ id: SOURCE_FARM, name: 'Finca Rosal' }],
  };
  // Understands the filters the module uses: eq.x and in.(a,b); select/order/limit are ignored.
  const get = jest.fn(async (t, p = {}) => db[t].filter(r => Object.entries(p).every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    const str = String(v);
    if (str.startsWith('eq.')) return String(r[k]) === str.slice(3);
    if (str.startsWith('in.(')) return str.slice(4, -1).split(',').includes(String(r[k]));
    return true;
  })));
  const patch = jest.fn(async (t, p, fields) => { const rows = db[t].filter(r => r.id === String(p.id).replace('eq.', '')); rows.forEach(r => Object.assign(r, fields)); return rows; });
  return { svc: createProductInfo({ get, patch }), get, patch, db };
}
const catalogs = { categorias: CATS, variedades: VARS, tuestes: ROASTS, procesos: PROCS, secados: DRYS, monedas: [{ codigo: 'PEN' }, { codigo: 'USD' }], lotesVerdes: [{ id: U(70) }, { id: U(71) }] };
const expectErr = async (p, status, field) => {
  await expect(p).rejects.toBeInstanceOf(InfoError);
  await p.catch(e => { expect(e.status).toBe(status); if (field) expect(e.field).toBe(field); });
};

describe('toApi', () => {
  test('maps columns to the Spanish API fields and never exposes slug or nutrition facts', () => {
    const api = toApi({ id: 'x', name: 'Obata', description: 'Breve', detail: 'Largo', category_id: U(10), variety_id: U(20), roast_level_id: U(30),
      process_method_id: U(40), drying_method_id: U(50), sensory_notes: ['Chocolate'], slug: 'obata', nutrition_facts: 'secret',
      manual_stock: true, currency: 'USD', green_lot_id: U(70), farm_id: FARM });
    expect(api).toEqual({ id: 'x', nombre: 'Obata', descripcionBreve: 'Breve', detalle: 'Largo', categoriaId: U(10), variedadId: U(20), tuesteId: U(30),
      procesoId: U(40), secadoId: U(50), notasSensoriales: ['Chocolate'], stockManual: true, moneda: 'USD', loteVerdeId: U(70) });
    expect(api).not.toHaveProperty('farm_id');
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

  describe('presentations settings: stock manual, currency and green lot', () => {
    test('getInfo exposes the three fields, the active currencies and only the farm\'s available lots', async () => {
      const { svc } = build();
      const r = await svc.getInfo(PROD);
      expect(r.producto).toMatchObject({ stockManual: false, moneda: 'PEN', loteVerdeId: null });
      expect(r.catalogos.monedas).toEqual([{ codigo: 'PEN', nombre: 'Sol peruano', simbolo: 'S/.' }, { codigo: 'USD', nombre: 'Dólar estadounidense', simbolo: '$' }]);
      expect(r.catalogos.lotesVerdes.map(l => l.id)).toEqual([U(70), U(71)]); // not the depleted one, not another farm's
    });

    test('lot labels read like the website: code, variety or blend, source farm, year, kg', async () => {
      const { svc } = build();
      const { catalogos } = await svc.getInfo(PROD);
      expect(catalogos.lotesVerdes[0]).toEqual({ id: U(70), etiqueta: 'L-2 · Obata · Finca Rosal · 2026 (195 kg disponibles)', kgDisponibles: 195 });
      expect(catalogos.lotesVerdes[1].etiqueta).toBe('L-3 · Caturra + Obata · 2025 (10.5 kg disponibles)');
    });

    test('the currently selected lot stays in the list even when it is depleted', async () => {
      const { svc, db } = build();
      db.products[0].green_lot_id = U(72);
      const { catalogos } = await svc.getInfo(PROD);
      expect(catalogos.lotesVerdes.map(l => l.id)).toContain(U(72));
    });

    test('a lot of ANOTHER farm cannot be assigned, and nothing is written', async () => {
      const { svc, patch } = build();
      await expectErr(svc.updateInfo(PROD, { loteVerdeId: U(73) }), 400, 'loteVerdeId');
      expect(patch).not.toHaveBeenCalled();
    });

    test('a depleted lot of the same farm is not offered either', async () => {
      await expectErr(build().svc.updateInfo(PROD, { loteVerdeId: U(72) }), 400, 'loteVerdeId');
    });

    test('assigning an own available lot, switching to manual stock and changing currency are saved', async () => {
      const { svc, patch } = build();
      const r = await svc.updateInfo(PROD, { loteVerdeId: U(70), stockManual: true, moneda: 'usd' });
      expect(patch).toHaveBeenCalledWith('products', { id: `eq.${PROD}` }, { green_lot_id: U(70), manual_stock: true, currency: 'USD' });
      expect(r).toMatchObject({ loteVerdeId: U(70), stockManual: true, moneda: 'USD' });
    });

    test('the lot can be cleared with null', async () => {
      const { svc, patch } = build();
      await svc.updateInfo(PROD, { loteVerdeId: null });
      expect(patch).toHaveBeenCalledWith('products', { id: `eq.${PROD}` }, { green_lot_id: null });
    });

    test.each([['"true" text', 'true'], ['number', 1], ['null', null]])('stockManual must be a real boolean (%s)', async (_l, v) => {
      await expectErr(build().svc.updateInfo(PROD, { stockManual: v }), 400, 'stockManual');
    });

    test.each([['unknown', 'ZZZ'], ['inactive', 'XXX'], ['empty', ''], ['not text', 5]])('currency must be an active one (%s)', async (_l, v) => {
      const { svc, patch } = build();
      await expectErr(svc.updateInfo(PROD, { moneda: v }), 400, 'moneda');
      expect(patch).not.toHaveBeenCalled();
    });

    test('stock manual alone does not load the catalogs', async () => {
      const { svc, get } = build();
      await svc.updateInfo(PROD, { stockManual: true });
      expect(get).not.toHaveBeenCalledWith('green_lots', expect.anything());
    });
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
