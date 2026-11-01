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
const FORMS = Object.freeze({
  // A gasto is a payment request: no money moves until Administración pays it (pagoGasto).
  // Each gasto carries the area that answers for it (filled from the category, editable) and optional links.
  gasto: {
    fn: 'admin_request_expense_v3',
    fields: {
      categoria: 'p_category', monto: 'p_amount', descripcion: 'p_description', area: 'p_area', centro: 'p_cost_centre',
      inversion: 'p_is_investment', loteId: 'p_lot_id', entregaId: 'p_delivery_id', compraId: 'p_purchase_id', envioId: 'p_shipment_id',
      equipoId: 'p_equipment_id', muestraId: 'p_sample_id', eventoId: 'p_event_booking_id', documentoId: 'p_document_id',
      parcelaId: 'p_plot_id', fecha: 'p_date',
    },
  },
  pagoGasto: {
    fn: 'admin_pay_expense',
    fields: { gastoId: 'p_expense_id', metodo: 'p_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  // An adelanto is a request too: Administración approves it (choosing how it is paid) or rejects it.
  adelanto: {
    fn: 'admin_request_advance',
    fields: { personaId: 'p_party_id', monto: 'p_amount', devuelveEn: 'p_repay_in', motivo: 'p_reason', fecha: 'p_date' },
  },
  aprobarAdelanto: {
    fn: 'admin_approve_advance',
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
  entrega: {
    fn: 'admin_record_delivery',
    fields: { agricultorId: 'p_farmer_id', estado: 'p_coffee_state', kg: 'p_kg', compradorId: 'p_buyer_id', precioKg: 'p_price_per_kg', humedad: 'p_moisture_pct', rendimiento: 'p_yield_factor', metodoPago: 'p_pay_method', operacion: 'p_bank_reference', notas: 'p_notes', fecha: 'p_date' },
  },
  precio: {
    fn: 'admin_set_price',
    fields: { entregaId: 'p_delivery_id', precioKg: 'p_price_per_kg', metodoPago: 'p_pay_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  pago: {
    fn: 'admin_pay_purchase',
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
});

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

  // Pending lists.
  router.get('/:businessId/pendientes', async (req, res) => {
    try {
      const entries = await Promise.all(Object.entries(PENDIENTES).map(async ([key, p]) => {
        const qs = new URLSearchParams({ select: '*', business_id: `eq.${req.admin.farmId}`, order: p.order, ...p.filter });
        const r = await db(req, `${p.view}?${qs}`);
        if (!r.ok) throw Object.assign(new Error('db'), { r });
        return [key, r.data || []];
      }));
      return res.json(Object.fromEntries(entries));
    } catch (err) {
      if (err && err.r) return sendDbError(res, err.r);
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
      return res.json({ rol: mine.role, solicitudes: r.data || [] });
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

  // Mi área: the areas of the person, and for the chosen one its costs by month and latest expenses.
  router.get('/:businessId/mi-area', async (req, res) => {
    try {
      const mine = await db(req, 'rpc/my_areas', { method: 'POST', body: { p_business_id: req.admin.farmId } });
      if (!mine.ok) return sendDbError(res, mine);
      const areas = mine.data || [];
      const pedida = typeof req.query.area === 'string' ? req.query.area : '';
      const area = areas.find(a => a.area === pedida) || areas[0];
      if (!area) return res.json({ areas: [], area: null, meses: [], gastos: [] });
      const farm = `eq.${req.admin.farmId}`;
      const [meses, gastos] = await Promise.all([
        db(req, `area_costs_by_month?${new URLSearchParams({ select: '*', business_id: farm, area: `eq.${area.area}`, order: 'month.desc' })}`),
        db(req, `area_expenses_recent?${new URLSearchParams({ select: '*', business_id: farm, area: `eq.${area.area}`, order: 'expense_date.desc,id.desc', limit: '30' })}`),
      ]);
      for (const r of [meses, gastos]) if (!r.ok) return sendDbError(res, r);
      return res.json({ areas, area: area.area, meses: meses.data || [], gastos: gastos.data || [] });
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
