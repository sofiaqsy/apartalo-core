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
 *
 * Deliberately NOT editable here: slug (the public URL) and nutrition_facts.
 * Ownership of the product is checked by the route guard before these functions run.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = Object.freeze({ nombre: 120, descripcionBreve: 300, detalle: 5000, notaLargo: 40, notas: 12 });

const INFO_SELECT = 'id,name,description,detail,category_id,variety_id,roast_level_id,process_method_id,drying_method_id,sensory_notes';

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
  return fields;
}

/**
 * @param {object} deps
 * @param {(path:string, params?:object)=>Promise<any>} deps.get
 * @param {(path:string, params:object, body:object)=>Promise<any>} deps.patch
 */
function createProductInfo({ get, patch }) {
  async function loadCatalogs() {
    const list = table => get(table, { select: 'id,name', order: 'sort_order.asc' });
    const [categorias, variedades, tuestes, procesos, secados, notas] = await Promise.all([
      list('product_categories'), list('coffee_varieties'), list('coffee_roast_levels'),
      list('coffee_process_methods'), list('coffee_drying_methods'), list('coffee_sensory_notes'),
    ]);
    const opts = rows => (rows || []).map(r => ({ id: r.id, nombre: r.name }));
    return { categorias: opts(categorias), variedades: opts(variedades), tuestes: opts(tuestes), procesos: opts(procesos), secados: opts(secados), notasSugeridas: (notas || []).map(r => r.name) };
  }

  async function getInfo(productId) {
    if (!UUID.test(String(productId || ''))) throw new InfoError(404, 'Producto no encontrado');
    const [rows, catalogs] = await Promise.all([get('products', { id: `eq.${productId}`, select: INFO_SELECT, limit: 1 }), loadCatalogs()]);
    if (!rows || !rows[0]) throw new InfoError(404, 'Producto no encontrado');
    return { producto: toApi(rows[0]), catalogos: catalogs };
  }

  async function updateInfo(productId, body) {
    if (!UUID.test(String(productId || ''))) throw new InfoError(404, 'Producto no encontrado');
    const needsCatalogs = ID_FIELDS.some(([f]) => body && body[f] !== undefined && body[f] !== null && body[f] !== '');
    const catalogs = needsCatalogs ? await loadCatalogs() : {};
    const fields = buildUpdate(body, catalogs);
    if (Object.keys(fields).length === 0) throw new InfoError(400, 'No hay cambios para guardar');
    const rows = await patch('products', { id: `eq.${productId}` }, fields);
    if (!rows || !rows[0]) throw new InfoError(404, 'Producto no encontrado');
    return toApi({ ...rows[0] });
  }

  return { getInfo, updateInfo };
}

module.exports = { createProductInfo, buildUpdate, toApi, InfoError, LIMITS, INFO_SELECT };
