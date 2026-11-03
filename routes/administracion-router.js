/**
 * ADMINISTRACIÓN ROUTER: the Administración tab of the app (expenses, advances, coffee deliveries,
 * prices, payments, money in, cash withdrawals, pending lists and the month view).
 *
 * The operations tables live in fincas (Supabase). This router never uses the service key: it
 * forwards the person's own Firebase token to the database functions, so the database rules decide
 * (member of the farm, owner-only advances, never delete). Only the forms and lists below are allowed.
 * Each call verifies the Firebase ID token itself, so it works whatever AUTH_MODE is.
 *
 * Server settings: SUPABASE_URL (already set) and SUPABASE_PUBLISHABLE_KEY (the project's public key,
 * sb_publishable_...). fincas must accept Firebase logins (Authentication > Third-party auth > Firebase,
 * project apartalo-10146); until then the database answers 401 and the app shows "sin acceso".
 */
const express = require('express');
const { extractBearer } = require('../core/middleware/auth');

/** Form name in the URL -> database function and the body fields it accepts (body -> parameter). */
// Money forms never ask for the operation number: the bank file fills it in when it matches the payment
// (General Manager, 1 Nov 2026; *_v2 functions, migration 0011).
const FORMS = Object.freeze({
  // A gasto is a payment request: no money moves until Administración pays it (pagoGasto).
  // Each gasto carries the area that answers for it (filled from the category, editable) and optional links.
  gasto: {
    // For Combustible the database finds the area itself (same-day purchase or delivery, the person's default);
    // paraQue is the optional one tap when it cannot.
    fn: 'admin_request_expense_v5',
    fields: {
      paraQue: 'p_purpose',
      categoria: 'p_category', monto: 'p_amount', descripcion: 'p_description', area: 'p_area', centro: 'p_cost_centre',
      inversion: 'p_is_investment', loteId: 'p_lot_id', entregaId: 'p_delivery_id', compraId: 'p_purchase_id', envioId: 'p_shipment_id',
      equipoId: 'p_equipment_id', muestraId: 'p_sample_id', eventoId: 'p_event_booking_id', documentoId: 'p_document_id',
      parcelaId: 'p_plot_id', fecha: 'p_date',
    },
  },
  // Administración sets a person's areas (two or more allowed, one principal); the others are ended, not deleted.
  areasPersona: {
    fn: 'admin_set_person_areas',
    fields: { perfilId: 'p_profile_id', areas: 'p_areas', principal: 'p_principal' },
  },
  // Administración corrects the area of an expense (a new record; the expense itself is kept).
  corregirArea: {
    fn: 'admin_correct_expense_area',
    fields: { gastoId: 'p_expense_id', area: 'p_area', centro: 'p_cost_centre', motivo: 'p_reason' },
  },
  pagoGasto: {
    fn: 'admin_pay_expense_v2',
    fields: { gastoId: 'p_expense_id', metodo: 'p_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  // An adelanto is a request too: Administración approves it (choosing how it is paid) or rejects it.
  adelanto: {
    fn: 'admin_request_advance',
    fields: { personaId: 'p_party_id', monto: 'p_amount', devuelveEn: 'p_repay_in', motivo: 'p_reason', fecha: 'p_date' },
  },
  aprobarAdelanto: {
    fn: 'admin_approve_advance_v2',
    fields: { solicitudId: 'p_request_id', metodo: 'p_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  rechazarAdelanto: {
    fn: 'admin_reject_advance',
    fields: { solicitudId: 'p_request_id', motivo: 'p_reason' },
  },
  // A new farmer, buyer or supplier.
  proveedor: {
    fn: 'admin_register_party',
    fields: { nombre: 'p_name', rol: 'p_role', tipo: 'p_kind', documento: 'p_dni_or_ruc', telefono: 'p_phone', vende: 'p_sells', recogidoPor: 'p_collected_by', comunidad: 'p_community' },
  },
  // Registrar compra (3 Nov 2026): v3 also links the product the coffee is for (checked to be this farm's).
  entrega: {
    fn: 'admin_record_delivery_v3',
    fields: { agricultorId: 'p_farmer_id', estado: 'p_coffee_state', kg: 'p_kg', compradorId: 'p_buyer_id', precioKg: 'p_price_per_kg', humedad: 'p_moisture_pct', rendimiento: 'p_yield_factor', metodoPago: 'p_pay_method', operacion: 'p_bank_reference', notas: 'p_notes', fecha: 'p_date', productoId: 'p_product_id' },
  },
  precio: {
    fn: 'admin_set_price_v2',
    fields: { entregaId: 'p_delivery_id', precioKg: 'p_price_per_kg', metodoPago: 'p_pay_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  pago: {
    fn: 'admin_pay_purchase_v2',
    fields: { compraId: 'p_purchase_id', monto: 'p_amount', metodo: 'p_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  ingreso: {
    fn: 'admin_record_money_in',
    fields: { tipo: 'p_kind', monto: 'p_amount', metodo: 'p_method', descripcion: 'p_description', personaId: 'p_party_id', adelantoId: 'p_advance_id', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  retiro: {
    fn: 'admin_cash_withdrawal',
    fields: { monto: 'p_amount', operacion: 'p_bank_reference', notas: 'p_notes', fecha: 'p_date' },
  },
});

/** Read-only lists for the Pendientes and Resumen parts (views; the rules show only the farm's rows). */
const PENDIENTES = Object.freeze({
  adelantos: { view: 'advance_balances', filter: { open_balance: 'gt.0' }, order: 'advance_date' },
  porPagar: { view: 'purchase_balances', filter: { still_owed: 'gt.0' }, order: 'purchase_date' },
  sinPrecio: { view: 'deliveries_awaiting_price', filter: {}, order: 'delivery_date' },
  gastosPorPagar: { view: 'expenses_to_pay', filter: {}, order: 'expense_date' },
  adelantosPorAprobar: { view: 'advance_requests_pending', filter: {}, order: 'request_date' },
  banco: { view: 'finance_bank_to_match', filter: {}, order: 'movement_date' },
  porRevisar: { view: 'expenses_to_review_v2', filter: {}, order: 'expense_date' },
});

/** Lower case, without accents, so "jose" finds "José". */
function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Body -> database parameters: only the allowed fields; empty values are left out so defaults apply. */
function toParams(form, body, farmId) {
  const params = { p_business_id: farmId };
  for (const [field, param] of Object.entries(form.fields)) {
    const value = body ? body[field] : undefined;
    if (value === undefined || value === null || value === '') continue;
    params[param] = typeof value === 'string' ? value.trim() : value;
  }
  const ref = body && typeof body.clientRef === 'string' ? body.clientRef.trim() : '';
  if (ref) params.p_client_ref = ref;
  return params;
}

/**
 * @param {object} deps
 * @param {(businessId:string)=>object|null} deps.getNegocio  e.g. negociosService.getById (has farmId)
 * @param {(token:string)=>Promise<object>} deps.verifyToken  firebaseService.verifyIdToken
 * @param {Function} [deps.fetchImpl]    fetch (injected in tests)
 * @param {()=>string} [deps.supabaseUrl]
 * @param {()=>string} [deps.publishableKey]
 */
function createAdministracionRouter({
  getNegocio,
  verifyToken,
  fetchImpl = (...a) => fetch(...a),
  supabaseUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, ''),
  publishableKey = () => process.env.SUPABASE_PUBLISHABLE_KEY || '',
} = {}) {
  const router = express.Router();

  // Login and business, for every route.
  router.use('/:businessId', async (req, res, next) => {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    try {
      await verifyToken(token);
    } catch (err) {
      if (err && err.code === 'auth/not-initialized') return res.status(503).json({ error: 'Autenticación no disponible' });
      return res.status(401).json({ error: 'Token inválido o vencido' });
    }
    const negocio = getNegocio(req.params.businessId);
    if (!negocio || !negocio.farmId) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (!supabaseUrl() || !publishableKey()) return res.status(503).json({ error: 'Administración no configurada en el servidor' });
    req.admin = { token, farmId: negocio.farmId };
    return next();
  });

  async function db(req, path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${supabaseUrl()}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: publishableKey(),
        Authorization: `Bearer ${req.admin.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { message: text }; }
    return { status: res.status, ok: res.ok, data };
  }

  /** Database errors carry plain messages written for the person ("Only the owner releases advances."). */
  function sendDbError(res, r) {
    const message = (r.data && (r.data.message || r.data.error)) || 'No se pudo guardar';
    const status = r.status === 401 || r.status === 403 ? 403 : 400;
    return res.status(status).json({ error: message });
  }

  // Forms.
  router.post('/:businessId/registrar/:form', async (req, res) => {
    const form = FORMS[req.params.form];
    if (!form) return res.status(404).json({ error: 'Formulario no encontrado' });
    try {
      const r = await db(req, `rpc/${form.fn}`, { method: 'POST', body: toParams(form, req.body, req.admin.farmId) });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ ok: true, result: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  /** Area of each expense (with Administración's corrections), so the app can show only the ticked areas. */
  async function areasDeGastos(req, ids) {
    if (!ids.length) return new Map();
    const qs = new URLSearchParams({ select: 'id,area', business_id: `eq.${req.admin.farmId}`, id: `in.(${ids.join(',')})` });
    const r = await db(req, `expenses_effective_area?${qs}`);
    return new Map(r.ok ? (r.data || []).map(x => [x.id, x.area]) : []);
  }

  // Pending lists.
  router.get('/:businessId/pendientes', async (req, res) => {
    try {
      const entries = await Promise.all(Object.entries(PENDIENTES).map(async ([key, p]) => {
        const qs = new URLSearchParams({ select: '*', business_id: `eq.${req.admin.farmId}`, order: p.order, ...p.filter });
        const r = await db(req, `${p.view}?${qs}`);
        if (!r.ok) throw Object.assign(new Error('db'), { r });
        return [key, r.data || []];
      }));
      const lists = Object.fromEntries(entries);
      // Each purchase to pay says which delivery it came from, so the app shows the delivery once, with its action.
      const ids = (lists.porPagar || []).map(p => p.id).filter(Boolean);
      if (ids.length) {
        const qs = new URLSearchParams({ select: 'id,delivery_id', business_id: `eq.${req.admin.farmId}`, id: `in.(${ids.join(',')})` });
        const r = await db(req, `purchases?${qs}`);
        if (r.ok) {
          const deliveryOf = new Map((r.data || []).map(x => [x.id, x.delivery_id]));
          lists.porPagar = lists.porPagar.map(p => ({ ...p, delivery_id: deliveryOf.get(p.id) || null }));
        }
      }
      const gastos = lists.gastosPorPagar || [];
      const areaDe = await areasDeGastos(req, gastos.map(g => g.id).filter(Boolean));
      lists.gastosPorPagar = gastos.map(g => ({ ...g, area: areaDe.get(g.id) || null }));
      return res.json(lists);
    } catch (err) {
      if (err && err.r) return sendDbError(res, err.r);
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Search people for the phone picker, a page at a time: q matches name or nickname (in the notes) without
  // caring about accents or capitals; rol = agricultor | comprador | ambos (either); limit at most 50.
  // area = a process: only its providers (party_areas, set by an owner, or who supplied its gastos). Compras
  // asks rol=agricultor instead: its providers are the farmers who sell coffee.
  router.get('/:businessId/personas/buscar', async (req, res) => {
    const q = normalizar(typeof req.query.q === 'string' ? req.query.q : '');
    const rol = ['agricultor', 'comprador', 'ambos'].includes(req.query.rol) ? req.query.rol : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const area = typeof req.query.area === 'string' && /^[a-z_]{2,30}$/.test(req.query.area) ? req.query.area : null;
    try {
      const farm = `eq.${req.admin.farmId}`;
      let delArea = null;
      if (area) {
        const [asignados, gastos] = await Promise.all([
          db(req, `party_areas?${new URLSearchParams({ select: 'party_id', business_id: farm, area: `eq.${area}`, active: 'is.true' })}`),
          db(req, `expenses?${new URLSearchParams({ select: 'supplier_party_id', business_id: farm, area: `eq.${area}`, supplier_party_id: 'not.is.null' })}`),
        ]);
        for (const r of [asignados, gastos]) if (!r.ok) return sendDbError(res, r);
        delArea = new Set([...(asignados.data || []).map(x => x.party_id), ...(gastos.data || []).map(x => x.supplier_party_id)]);
      }
      const [parties, farmers, buyers] = await Promise.all([
        db(req, `parties?${new URLSearchParams({ select: 'id,name,kind,notes', business_id: farm, status: 'eq.active', order: 'name' })}`),
        db(req, `farmers?${new URLSearchParams({ select: 'party_id,sells,collected_by', business_id: farm })}`),
        db(req, `buyers?${new URLSearchParams({ select: 'party_id,active', business_id: farm })}`),
      ]);
      for (const r of [parties, farmers, buyers]) if (!r.ok) return sendDbError(res, r);
      const farmerById = new Map((farmers.data || []).map(f => [f.party_id, f]));
      const buyerIds = new Set((buyers.data || []).filter(b => b.active).map(b => b.party_id));
      const nombreById = new Map((parties.data || []).map(p => [p.id, p.name]));
      const todos = (parties.data || [])
        .filter(p => !delArea || delArea.has(p.id))
        .filter(p => !q || normalizar(`${p.name} ${p.notes || ''}`).includes(q))
        .filter(p => !rol
          || (rol === 'agricultor' && farmerById.has(p.id))
          || (rol === 'comprador' && buyerIds.has(p.id))
          || (rol === 'ambos' && (farmerById.has(p.id) || buyerIds.has(p.id))));
      const pagina = todos.slice(offset, offset + limit).map(p => ({
        id: p.id,
        nombre: p.name,
        detalle: p.notes || null,
        agricultor: farmerById.has(p.id),
        comprador: buyerIds.has(p.id),
        vende: farmerById.get(p.id) ? farmerById.get(p.id).sells : null,
        recogidoPor: farmerById.get(p.id) ? farmerById.get(p.id).collected_by : null,
        recogidoPorNombre: farmerById.get(p.id) && farmerById.get(p.id).collected_by
          ? (nombreById.get(farmerById.get(p.id).collected_by) || null) : null,
      }));
      return res.json({ personas: pagina, total: todos.length, hayMas: offset + limit < todos.length });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // People to choose in the forms: farmers, buyers and everyone else of the farm.
  router.get('/:businessId/personas', async (req, res) => {
    try {
      const farm = `eq.${req.admin.farmId}`;
      const [parties, farmers, buyers] = await Promise.all([
        db(req, `parties?${new URLSearchParams({ select: 'id,name,kind,status', business_id: farm, status: 'eq.active', order: 'name' })}`),
        db(req, `farmers?${new URLSearchParams({ select: 'party_id,sells,collected_by', business_id: farm })}`),
        db(req, `buyers?${new URLSearchParams({ select: 'party_id,active', business_id: farm })}`),
      ]);
      for (const r of [parties, farmers, buyers]) if (!r.ok) return sendDbError(res, r);
      const farmerById = new Map((farmers.data || []).map(f => [f.party_id, f]));
      const buyerIds = new Set((buyers.data || []).filter(b => b.active).map(b => b.party_id));
      return res.json((parties.data || []).map(p => ({
        id: p.id,
        nombre: p.name,
        agricultor: farmerById.has(p.id),
        comprador: buyerIds.has(p.id),
        recogidoPor: farmerById.get(p.id) ? farmerById.get(p.id).collected_by : null,
      })));
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Mis solicitudes: what each person sent and where it stands. The owner sees everyone's.
  router.get('/:businessId/solicitudes', async (req, res) => {
    try {
      const me = await db(req, 'rpc/my_memberships', { method: 'POST', body: {} });
      if (!me.ok) return sendDbError(res, me);
      const mine = (me.data || []).find(m => m.business_id === req.admin.farmId);
      if (!mine) return res.status(403).json({ error: 'Sin acceso a este negocio' });
      const qs = new URLSearchParams({ select: '*', business_id: `eq.${req.admin.farmId}`, order: 'request_date.desc,id.desc', limit: '200' });
      if (mine.role !== 'owner') qs.set('mine', 'is.true');
      const r = await db(req, `my_requests?${qs}`);
      if (!r.ok) return sendDbError(res, r);
      const filas = r.data || [];
      const areaDe = await areasDeGastos(req, filas.filter(f => f.kind === 'gasto').map(f => f.id).filter(Boolean));
      return res.json({ rol: mine.role, solicitudes: filas.map(f => (f.kind === 'gasto' ? { ...f, area: areaDe.get(f.id) || null } : f)) });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Expense categories still offered, with what goes in each, the area and cost centre each one suggests,
  // and whether it is a main chip; plus the list of areas.
  router.get('/:businessId/categorias', async (req, res) => {
    try {
      const [cats, areas] = await Promise.all([
        db(req, `expense_category_guide?${new URLSearchParams({
          select: 'category,what_goes_here,not_here,default_area,default_cost_centre,is_investment,needs_description,main',
          active: 'is.true', order: 'sort_order',
        })}`),
        db(req, `areas?${new URLSearchParams({ select: 'id,name', order: 'sort_order' })}`),
      ]);
      for (const r of [cats, areas]) if (!r.ok) return sendDbError(res, r);
      return res.json({ categorias: cats.data || [], areas: areas.data || [] });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // The team (owners only): each person's role and active areas.
  router.get('/:businessId/equipo', async (req, res) => {
    try {
      const r = await db(req, 'rpc/team_members', { method: 'POST', body: { p_business_id: req.admin.farmId } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ equipo: r.data || [] });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Areas suggested for a person from what they registered in the last 60 days (owners only).
  router.get('/:businessId/equipo/:perfilId/sugerencia', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.perfilId)) return res.status(400).json({ error: 'Persona no válida' });
    try {
      const r = await db(req, 'rpc/suggest_person_areas', { method: 'POST', body: { p_profile_id: req.params.perfilId, p_business_id: req.admin.farmId } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ sugeridas: r.data || [] });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // What the database would set as the area of an expense, before saving (for the form's summary line).
  router.get('/:businessId/sugerir-area', async (req, res) => {
    const categoria = typeof req.query.categoria === 'string' ? req.query.categoria.trim() : '';
    const fecha = typeof req.query.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha) ? req.query.fecha : undefined;
    if (!categoria) return res.status(400).json({ error: 'Falta la categoría' });
    try {
      const r = await db(req, 'rpc/suggest_expense_area_v2', {
        method: 'POST', body: { p_category: categoria, p_business_id: req.admin.farmId, ...(fecha ? { p_date: fecha } : {}) },
      });
      if (!r.ok) return sendDbError(res, r);
      return res.json(r.data || {});
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Mi área: the person's areas, and for the chosen ones (one, several, or "todas") their costs by month and
  // latest expenses. Only areas the person belongs to count (owners: every area); each expense has one area,
  // so adding areas never counts a cost twice.
  router.get('/:businessId/mi-area', async (req, res) => {
    try {
      const mine = await db(req, 'rpc/my_areas_v2', { method: 'POST', body: { p_business_id: req.admin.farmId } });
      if (!mine.ok) return sendDbError(res, mine);
      const areas = mine.data || [];
      if (!areas.length) return res.json({ areas: [], area: null, elegidas: [], meses: [], gastos: [] });
      const permitidas = new Set(areas.map(a => a.area));
      const pedido = typeof req.query.area === 'string' ? req.query.area.trim() : '';
      let elegidas = pedido === 'todas' ? [...permitidas] : pedido.split(',').map(a => a.trim()).filter(a => permitidas.has(a));
      if (!elegidas.length) elegidas = [areas[0].area];
      const farm = `eq.${req.admin.farmId}`;
      const filtro = `in.(${elegidas.join(',')})`;
      const [meses, gastos] = await Promise.all([
        db(req, `area_costs_by_month_v2?${new URLSearchParams({ select: '*', business_id: farm, area: filtro, order: 'month.desc' })}`),
        db(req, `area_expenses_recent_v2?${new URLSearchParams({ select: '*', business_id: farm, area: filtro, order: 'expense_date.desc,id.desc', limit: '30' })}`),
      ]);
      for (const r of [meses, gastos]) if (!r.ok) return sendDbError(res, r);
      return res.json({ areas, area: elegidas[0], elegidas, meses: meses.data || [], gastos: gastos.data || [] });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Finca, Compras, Producción and Comercialización cards: one summary each, from the database (money only for
  // owners, decided there). Comercialización is Apartalo's store sales by month (apartalo_sales_by_month).
  // Only the processes of the person's own areas are sent (my_areas_v2: owners have every area), so hiding a
  // card in the app is never the only protection (General Manager, 3 Nov 2026).
  const PROCESOS = [
    { key: 'finca', area: 'farm', fn: 'farm_summary' },
    { key: 'compras', area: 'sourcing', fn: 'purchasing_summary_v2' },
    { key: 'produccion', area: 'production', fn: 'production_summary' },
    { key: 'comercial', area: 'commercial', fn: 'apartalo_sales_by_month', wrap: data => ({ meses: data || [] }) },
    { key: 'logistica', area: 'fulfillment', fn: 'logistics_summary' },
    { key: 'finanzas', area: 'finance', fn: 'finance_summary' }, // money: the database answers only to owners
  ];
  router.get('/:businessId/procesos', async (req, res) => {
    try {
      const body = { p_business_id: req.admin.farmId };
      const mine = await db(req, 'rpc/my_areas_v2', { method: 'POST', body });
      if (!mine.ok) return sendDbError(res, mine);
      const permitidas = new Set((mine.data || []).map(a => a.area));
      const pedidos = PROCESOS.filter(p => permitidas.has(p.area));
      const respuestas = await Promise.all(pedidos.map(p => db(req, `rpc/${p.fn}`, { method: 'POST', body })));
      for (const r of respuestas) if (!r.ok) return sendDbError(res, r);
      const out = {};
      pedidos.forEach((p, i) => { out[p.key] = p.wrap ? p.wrap(respuestas[i].data) : respuestas[i].data; });
      return res.json(out);
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  /** True when the person works in this area (owners have every area), as my_areas_v2 says. */
  async function tieneArea(req, area) {
    const mine = await db(req, 'rpc/my_areas_v2', { method: 'POST', body: { p_business_id: req.admin.farmId } });
    return mine.ok && (mine.data || []).some(a => a.area === area);
  }

  // Compras tab: purchases newest first, a page at a time (offset, limit at most 50); only for the Compras area.
  router.get('/:businessId/compras', async (req, res) => {
    try {
      if (!(await tieneArea(req, 'sourcing'))) return res.status(403).json({ error: 'Compras no es de tus áreas.' });
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const r = await db(req, 'rpc/purchases_page_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_offset: offset, p_limit: limit } });
      if (!r.ok) return sendDbError(res, r);
      const total = (r.data && r.data.total) || 0;
      const filas = (r.data && r.data.filas) || [];
      return res.json({ compras: filas, total, hayMas: offset + filas.length < total });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // One purchase with its detail; only for the Compras area.
  router.get('/:businessId/compras/:id', async (req, res) => {
    try {
      if (!(await tieneArea(req, 'sourcing'))) return res.status(403).json({ error: 'Compras no es de tus áreas.' });
      const r = await db(req, 'rpc/purchase_detail_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_delivery_id: String(req.params.id).slice(0, 40) } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ compra: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Role of the person in this farm, and the month view (only for the owner).
  router.get('/:businessId/resumen', async (req, res) => {
    try {
      const me = await db(req, 'rpc/my_memberships', { method: 'POST', body: {} });
      if (!me.ok) return sendDbError(res, me);
      const mine = (me.data || []).find(m => m.business_id === req.admin.farmId);
      if (!mine) return res.status(403).json({ error: 'Sin acceso a este negocio' });
      if (mine.role !== 'owner') return res.json({ rol: mine.role, meses: [] });
      const qs = new URLSearchParams({ select: '*', business_id: `eq.${req.admin.farmId}`, order: 'month.desc,account' });
      const months = await db(req, `finance_account_months?${qs}`);
      if (!months.ok) return sendDbError(res, months);
      return res.json({ rol: mine.role, meses: months.data || [] });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  return router;
}

module.exports = { createAdministracionRouter, FORMS, PENDIENTES, toParams };
