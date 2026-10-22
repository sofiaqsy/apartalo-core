/**
 * PRODUCT INFO: the "Información general" of a product.
 *
 * Where each field lives (products table, verified in Supabase):
 *   nombre            -> name
 *   descripcionBreve  -> description
 *   detalle           -> detail
 *   categoriaId       -> category_id        (product_categories)
 *   variedadId        -> variety_id         (coffee_varieties)
 *   tuesteId          -> roast_level_id     (coffee_roast_levels)
 *   procesoId         -> process_method_id  (coffee_process_methods)
 *   secadoId          -> drying_method_id   (coffee_drying_methods)
 *   notasSensoriales  -> sensory_notes      (text[]; suggestions come from coffee_sensory_notes)
 *   stockManual       -> manual_stock       (true: stock typed by hand per presentation; false: from roasts)
 *   moneda            -> currency           (currencies.code)
 *   loteVerdeId       -> green_lot_id       (green_lots of the SAME farm as the product)
 *
 * Deliberately NOT editable here: slug (the public URL) and nutrition_facts.
 * Ownership of the product is checked by the route guard before these functions run.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = Object.freeze({ nombre: 120, descripcionBreve: 300, detalle: 5000, notaLargo: 40, notas: 12 });

const INFO_SELECT = 'id,farm_id,name,description,detail,category_id,variety_id,roast_level_id,process_method_id,drying_method_id,sensory_notes,manual_stock,currency,green_lot_id';

class InfoError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field || null; }
}

const ID_FIELDS = [
  // api field, column, catalog key, label (Spanish, shown to the user)
  ['categoriaId', 'category_id', 'categorias', 'categoría'],
  ['variedadId', 'variety_id', 'variedades', 'variedad'],
  ['tuesteId', 'roast_level_id', 'tuestes', 'tueste'],
  ['procesoId', 'process_method_id', 'procesos', 'proceso'],
  ['secadoId', 'drying_method_id', 'secados', 'técnica de secado'],
  ['loteVerdeId', 'green_lot_id', 'lotesVerdes', 'lote verde'],
];

function toApi(row) {
  return {
    id: row.id,
    nombre: row.name || '',
    descripcionBreve: row.description || '',
    detalle: row.detail || '',
    categoriaId: row.category_id || null,
    variedadId: row.variety_id || null,
    tuesteId: row.roast_level_id || null,
    procesoId: row.process_method_id || null,
    secadoId: row.drying_method_id || null,
    notasSensoriales: Array.isArray(row.sensory_notes) ? row.sensory_notes : [],
    stockManual: row.manual_stock === true,
    moneda: row.currency || null,
    loteVerdeId: row.green_lot_id || null,
  };
}

function cleanText(value, max, field, label) {
  if (typeof value !== 'string') throw new InfoError(400, `${label} no es válido`, field);
  const text = value.trim();
  if (text.length > max) throw new InfoError(400, `${label} es muy largo (máximo ${max} caracteres)`, field);
  return text;
}

function cleanNotes(value) {
  if (!Array.isArray(value)) throw new InfoError(400, 'Las notas sensoriales no son válidas', 'notasSensoriales');
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new InfoError(400, 'Las notas sensoriales no son válidas', 'notasSensoriales');
    const note = raw.trim();
    if (!note) continue;
    if (note.length > LIMITS.notaLargo) throw new InfoError(400, `Cada nota puede tener hasta ${LIMITS.notaLargo} caracteres`, 'notasSensoriales');
    const key = note.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(note);
  }
  if (out.length > LIMITS.notas) throw new InfoError(400, `Máximo ${LIMITS.notas} notas sensoriales`, 'notasSensoriales');
  return out;
}

/** Turns a request body into column updates. Only known fields are read; everything else is ignored. */
function buildUpdate(body, catalogs) {
  const b = body || {};
  const fields = {};

  if (b.nombre !== undefined) {
    const nombre = cleanText(b.nombre, LIMITS.nombre, 'nombre', 'El nombre');
    if (!nombre) throw new InfoError(400, 'El nombre es obligatorio', 'nombre');
    fields.name = nombre;
  }
  if (b.descripcionBreve !== undefined) fields.description = cleanText(b.descripcionBreve, LIMITS.descripcionBreve, 'descripcionBreve', 'La descripción breve') || null;
  if (b.detalle !== undefined) fields.detail = cleanText(b.detalle, LIMITS.detalle, 'detalle', 'El detalle') || null;

  for (const [apiField, column, catalogKey, label] of ID_FIELDS) {
    if (b[apiField] === undefined) continue;
    const id = b[apiField];
    if (id === null || id === '') { fields[column] = null; continue; }
    if (typeof id !== 'string' || !UUID.test(id) || !(catalogs[catalogKey] || []).some(c => c.id === id)) {
      throw new InfoError(400, `La opción de ${label} no existe`, apiField);
    }
    fields[column] = id;
  }

  if (b.notasSensoriales !== undefined) fields.sensory_notes = cleanNotes(b.notasSensoriales);

  if (b.stockManual !== undefined) {
    if (typeof b.stockManual !== 'boolean') throw new InfoError(400, 'El stock manual no es válido', 'stockManual');
    fields.manual_stock = b.stockManual;
  }
  if (b.moneda !== undefined) {
    const code = typeof b.moneda === 'string' ? b.moneda.trim().toUpperCase() : '';
    if (!(catalogs.monedas || []).some(m => m.codigo === code)) throw new InfoError(400, 'La moneda no existe', 'moneda');
    fields.currency = code;
  }
  return fields;
}

/**
 * @param {object} deps
 * @param {(path:string, params?:object)=>Promise<any>} deps.get
 * @param {(path:string, params:object, body:object)=>Promise<any>} deps.patch
 */
function createProductInfo({ get, patch }) {
  /** Green lots a product of `farmId` may sell: the farm's available lots, plus the one already selected. */
  async function loadLotes(farmId, variedades, selectedId) {
    if (!farmId) return [];
    const lots = await get('green_lots', {
      roastery_farm_id: `eq.${farmId}`, status: 'eq.available',
      select: 'id,lot_code,variety_id,source_farm_id,harvest_year,current_kg,blend_varieties', order: 'created_at.asc',
    });
    const list = [...(lots || [])];
    if (selectedId && UUID.test(selectedId) && !list.some(l => l.id === selectedId)) {
      const current = await get('green_lots', { id: `eq.${selectedId}`, roastery_farm_id: `eq.${farmId}`, select: 'id,lot_code,variety_id,source_farm_id,harvest_year,current_kg,blend_varieties', limit: 1 });
      if (current && current[0]) list.push(current[0]);
    }
    const sourceIds = [...new Set(list.map(l => l.source_farm_id).filter(Boolean))];
    const farms = sourceIds.length ? await get('farms', { id: `in.(${sourceIds.join(',')})`, select: 'id,name' }) : [];
    const farmName = Object.fromEntries((farms || []).map(f => [f.id, f.name]));
    const varietyName = Object.fromEntries((variedades || []).map(v => [v.id, v.nombre]));
    return list.map(l => {
      const kg = Number(l.current_kg) || 0;
      const blend = Array.isArray(l.blend_varieties) && l.blend_varieties.length ? l.blend_varieties.join(' + ') : null;
      const etiqueta = [l.lot_code, blend || varietyName[l.variety_id], farmName[l.source_farm_id], l.harvest_year].filter(Boolean).join(' · ');
      return { id: l.id, etiqueta: `${etiqueta} (${Math.round(kg * 100) / 100} kg disponibles)`, kgDisponibles: kg };
    });
  }

  async function loadCatalogs({ farmId = null, selectedLotId = null } = {}) {
    const list = table => get(table, { select: 'id,name', order: 'sort_order.asc' });
    const [categorias, variedades, tuestes, procesos, secados, notas, monedas] = await Promise.all([
      list('product_categories'), list('coffee_varieties'), list('coffee_roast_levels'),
      list('coffee_process_methods'), list('coffee_drying_methods'), list('coffee_sensory_notes'),
      get('currencies', { is_active: 'eq.true', select: 'code,name,symbol', order: 'sort_order.asc' }),
    ]);
    const opts = rows => (rows || []).map(r => ({ id: r.id, nombre: r.name }));
    const variedadesOpts = opts(variedades);
    return {
      categorias: opts(categorias), variedades: variedadesOpts, tuestes: opts(tuestes), procesos: opts(procesos), secados: opts(secados),
      notasSugeridas: (notas || []).map(r => r.name),
      monedas: (monedas || []).map(m => ({ codigo: m.code, nombre: m.name, simbolo: m.symbol })),
      lotesVerdes: await loadLotes(farmId, variedadesOpts, selectedLotId),
    };
  }

  async function getInfo(productId) {
    if (!UUID.test(String(productId || ''))) throw new InfoError(404, 'Producto no encontrado');
    const rows = await get('products', { id: `eq.${productId}`, select: INFO_SELECT, limit: 1 });
    if (!rows || !rows[0]) throw new InfoError(404, 'Producto no encontrado');
    const catalogs = await loadCatalogs({ farmId: rows[0].farm_id, selectedLotId: rows[0].green_lot_id });
    return { producto: toApi(rows[0]), catalogos: catalogs };
  }

  async function updateInfo(productId, body) {
    if (!UUID.test(String(productId || ''))) throw new InfoError(404, 'Producto no encontrado');
    const b = body || {};
    const needsCatalogs = ID_FIELDS.some(([f]) => b[f] !== undefined && b[f] !== null && b[f] !== '') || b.moneda !== undefined;
    let catalogs = {};
    if (needsCatalogs) {
      // The green lot must belong to the product's own farm: read the product first.
      const own = await get('products', { id: `eq.${productId}`, select: 'id,farm_id', limit: 1 });
      if (!own || !own[0]) throw new InfoError(404, 'Producto no encontrado');
      catalogs = await loadCatalogs({ farmId: own[0].farm_id });
    }
    const fields = buildUpdate(body, catalogs);
    if (Object.keys(fields).length === 0) throw new InfoError(400, 'No hay cambios para guardar');
    const rows = await patch('products', { id: `eq.${productId}` }, fields);
    if (!rows || !rows[0]) throw new InfoError(404, 'Producto no encontrado');
    return toApi({ ...rows[0] });
  }

  return { getInfo, updateInfo };
}

module.exports = { createProductInfo, buildUpdate, toApi, InfoError, LIMITS, INFO_SELECT };
