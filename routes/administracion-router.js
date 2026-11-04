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
const crypto = require('crypto');
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
  // Editar proveedor and its payment accounts (3 Nov 2026, owners only, decided by the database). An account is
  // never edited in place: cuentaProveedor with reemplazaId archives the old one and adds the new one.
  editarProveedor: {
    fn: 'admin_update_party',
    fields: { proveedorId: 'p_party_id', nombre: 'p_name', documento: 'p_dni_or_ruc', telefono: 'p_phone', comunidad: 'p_community', notas: 'p_notes' },
  },
  cuentaProveedor: {
    fn: 'admin_save_payment_method',
    fields: { proveedorId: 'p_party_id', tipo: 'p_kind', numero: 'p_number', banco: 'p_bank', titular: 'p_holder', reemplazaId: 'p_replace_id' },
  },
  quitarCuenta: {
    fn: 'admin_archive_payment_method',
    fields: { cuentaId: 'p_method_id' },
  },
  // Quitar evidencia (owners): archived, never deleted. Subir evidencia has its own route (it carries a file).
  quitarEvidencia: {
    fn: 'admin_archive_evidence',
    fields: { evidenciaId: 'p_evidence_id' },
  },
  // Registrar compra (3 Nov 2026): links the product the coffee is for; v4 (fincas 0026) never uses advances by itself.
  entrega: {
    fn: 'admin_record_delivery_v4',
    fields: { agricultorId: 'p_farmer_id', estado: 'p_coffee_state', kg: 'p_kg', compradorId: 'p_buyer_id', precioKg: 'p_price_per_kg', humedad: 'p_moisture_pct', rendimiento: 'p_yield_factor', metodoPago: 'p_pay_method', operacion: 'p_bank_reference', notas: 'p_notes', fecha: 'p_date', productoId: 'p_product_id' },
  },
  // Poner precio: v3 (fincas 0026) never uses advances by itself.
  precio: {
    fn: 'admin_set_price_v3',
    fields: { entregaId: 'p_delivery_id', precioKg: 'p_price_per_kg', metodoPago: 'p_pay_method', operacion: 'p_bank_reference', fecha: 'p_date' },
  },
  // Solicitar pago (3 Nov 2026): on demand, with the amount and how (transfer, or the farmer's own advance).
  solicitarPago: {
    fn: 'admin_request_purchase_payment_v2',
    fields: { compraId: 'p_purchase_id', monto: 'p_amount', metodo: 'p_method', adelantoId: 'p_advance_id', nota: 'p_note' },
  },
  // Finanzas confirms a request paid with an advance (owners only, decided by the database).
  pagoConAdelanto: {
    fn: 'admin_pay_purchase_with_advance',
    fields: { solicitudId: 'p_request_id' },
  },
  // Marcar como pagado desde adelantos (3 Nov 2026): the farmer's own open advances, owners only (decided by the database).
  pagoDesdeAdelantos: {
    fn: 'admin_pay_purchase_from_advances',
    fields: { compraId: 'p_purchase_id' },
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
  // Only for the private evidence bucket, and only after the database said yes with the person's own login.
  serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '',
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
        const farm = `eq.${req.admin.farmId}`;
        const [r, abiertas] = await Promise.all([
          db(req, `purchases?${new URLSearchParams({ select: 'id,delivery_id', business_id: farm, id: `in.(${ids.join(',')})` })}`),
          db(req, `purchase_open_requests?${new URLSearchParams({ select: 'purchase_id', business_id: farm, purchase_id: `in.(${ids.join(',')})` })}`),
        ]);
        if (r.ok) {
          const deliveryOf = new Map((r.data || []).map(x => [x.id, x.delivery_id]));
          const pedidas = new Set(abiertas.ok ? (abiertas.data || []).map(x => x.purchase_id) : []);
          lists.porPagar = lists.porPagar.map(p => ({ ...p, delivery_id: deliveryOf.get(p.id) || null, pago_solicitado: pedidas.has(p.id) }));
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
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
    const rol = ['agricultor', 'comprador', 'ambos'].includes(req.query.rol) ? req.query.rol : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const area = typeof req.query.area === 'string' && /^[a-z_]{2,30}$/.test(req.query.area) ? req.query.area : null;
    try {
      // The database filters and cuts the page (3 Nov 2026); before, every provider was read and cut here.
      const r = await db(req, 'rpc/parties_page', { method: 'POST', body: { p_business_id: req.admin.farmId, p_q: q || null, p_rol: rol, p_area: area, p_offset: offset, p_limit: limit } });
      if (!r.ok) return sendDbError(res, r);
      const total = (r.data && r.data.total) || 0;
      const personas = (r.data && r.data.personas) || [];
      return res.json({ personas, total, hayMas: offset + personas.length < total });
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
    { key: 'produccion', area: 'production', fn: 'production_summary_v6' }, // by product, every open green lot with its product, and the Blend lot's compras with their estimated green (4 Nov 2026)
    { key: 'comercial', area: 'commercial', fn: 'apartalo_sales_by_month', wrap: data => ({ meses: data || [] }) },
    { key: 'logistica', area: 'fulfillment', fn: 'logistics_summary' },
    { key: 'finanzas', area: 'finance', fn: 'finance_summary_v4' }, // money: the database answers only to owners
  ];
  router.get('/:businessId/procesos', async (req, res) => {
    try {
      const body = { p_business_id: req.admin.farmId };
      const mine = await db(req, 'rpc/my_areas_v2', { method: 'POST', body });
      if (!mine.ok) return sendDbError(res, mine);
      const permitidas = new Set((mine.data || []).map(a => a.area));
      // ?solo=compras: a process screen asks only for its own summary (3 Nov 2026), not all of them.
      const solo = typeof req.query.solo === 'string' ? req.query.solo : null;
      const pedidos = PROCESOS.filter(p => permitidas.has(p.area) && (!solo || p.key === solo));
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
      const r = await db(req, 'rpc/purchases_page_v4', { method: 'POST', body: { p_business_id: req.admin.farmId, p_offset: offset, p_limit: limit } });
      if (!r.ok) return sendDbError(res, r);
      const total = (r.data && r.data.total) || 0;
      const filas = (r.data && r.data.filas) || [];
      return res.json({ compras: filas, total, hayMas: offset + filas.length < total });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Finanzas lists (3 Nov 2026): compras, gastos or adelantos; what waits (Pendiente or Urgente) and the last 30 days
  // of what was paid or decided, a page at a time (limit at most 50). Owners only, decided by the database.
  // finance_list_v2 (4 Nov 2026): each gasto also says whether its area needs review (revisar).
  router.get('/:businessId/finanzas/lista', async (req, res) => {
    try {
      const tipo = String(req.query.tipo || '');
      if (!['compras', 'gastos', 'adelantos'].includes(tipo)) return res.status(400).json({ error: 'Elige compras, gastos o adelantos.' });
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const r = await db(req, 'rpc/finance_list_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_kind: tipo, p_offset: offset, p_limit: limit } });
      if (!r.ok) return sendDbError(res, r);
      const total = (r.data && r.data.total) || 0;
      const filas = (r.data && r.data.filas) || [];
      return res.json({ filas, total, hayMas: offset + filas.length < total });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Compras → Adelantos (3 Nov 2026): the requests waiting for Finanzas (first page only) and the advances, newest
  // first, a page at a time (limit at most 50), with the person's name. Only for the Compras area.
  router.get('/:businessId/adelantos', async (req, res) => {
    try {
      if (!(await tieneArea(req, 'sourcing'))) return res.status(403).json({ error: 'Compras no es de tus áreas.' });
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const farm = `eq.${req.admin.farmId}`;
      const [adv, pedidos] = await Promise.all([
        db(req, `advance_balances?${new URLSearchParams({ select: 'id,party_id,advance_date,amount,used_in_coffee,returned_in_money,open_balance,status,settle_by', business_id: farm, order: 'advance_date.desc,id.desc', offset: String(offset), limit: String(limit) })}`),
        offset === 0
          ? db(req, `advance_requests_pending?${new URLSearchParams({ select: 'id,request_date,party,amount,reason,created_by', business_id: farm, order: 'request_date.desc' })}`)
          : Promise.resolve({ ok: true, data: [] }),
      ]);
      for (const r of [adv, pedidos]) if (!r.ok) return sendDbError(res, r);
      const filas = adv.data || [];
      const ids = [...new Set(filas.map(a => a.party_id).filter(Boolean))];
      let nombre = new Map();
      if (ids.length) {
        const pr = await db(req, `parties?${new URLSearchParams({ select: 'id,name', business_id: farm, id: `in.(${ids.join(',')})` })}`);
        if (pr.ok) nombre = new Map((pr.data || []).map(x => [x.id, x.name]));
      }
      return res.json({
        porAprobar: pedidos.data || [],
        adelantos: filas.map(a => ({ ...a, nombre: nombre.get(a.party_id) || null })),
        hayMas: filas.length === limit,
      });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // A provider's detail (3 Nov 2026). The database gives DNI or RUC, phone, accounts and money only to owners.
  router.get('/:businessId/proveedores/:id', async (req, res) => {
    try {
      const r = await db(req, 'rpc/party_detail_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_party_id: String(req.params.id).slice(0, 40) } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ proveedor: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Generar reporte: everything for the PDF, read only when asked (money only for owners, decided by the database).
  // Compras report (4 Nov 2026): a range of months, ?desde=2026-05&hasta=2026-09 (at most 12 months, checked by the
  // database: purchasing_report_v2). The old ?anio=2026&mes=11 still works (one month, or the whole year without mes).
  // Content decided by the Sourcing Manager; money only for owners, decided by the database.
  router.get('/:businessId/compras/reporte', async (req, res) => {
    try {
      const mesValido = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
      let desde = req.query.desde;
      let hasta = req.query.hasta;
      if (desde === undefined && hasta === undefined) {
        const anio = parseInt(req.query.anio, 10);
        const mes = req.query.mes === undefined || req.query.mes === '' ? null : parseInt(req.query.mes, 10);
        if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return res.status(400).json({ error: 'Elige un año.' });
        if (mes !== null && (!Number.isInteger(mes) || mes < 1 || mes > 12)) return res.status(400).json({ error: 'Elige un mes del 1 al 12.' });
        const mm = String(mes || 1).padStart(2, '0');
        desde = `${anio}-${mm}`;
        hasta = mes === null ? `${anio}-12` : `${anio}-${mm}`;
      }
      if (!mesValido(desde) || !mesValido(hasta)) return res.status(400).json({ error: 'Elige el mes Desde y el mes Hasta.' });
      const [ha, hm] = hasta.split('-').map(Number);
      const fin = new Date(Date.UTC(ha, hm, 0)).toISOString().slice(0, 10); // last day of the Hasta month
      const r = await db(req, 'rpc/purchasing_report_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_from: `${desde}-01`, p_to: fin } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ reporte: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Producción report (4 Nov 2026): the same form as Compras, ?desde=2026-05&hasta=2026-09 (at most 12 months, checked by
  // the database: production_report_v2, roasted coffee by product as the product screen). Content decided by the Production Manager; costs only for owners.
  router.get('/:businessId/produccion/reporte', async (req, res) => {
    try {
      const mesValido = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
      const { desde, hasta } = req.query;
      if (!mesValido(desde) || !mesValido(hasta)) return res.status(400).json({ error: 'Elige el mes Desde y el mes Hasta.' });
      const [ha, hm] = hasta.split('-').map(Number);
      const fin = new Date(Date.UTC(ha, hm, 0)).toISOString().slice(0, 10); // last day of the Hasta month
      const r = await db(req, 'rpc/production_report_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_from: `${desde}-01`, p_to: fin } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ reporte: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Detail of a roasted lot (General Manager, 4 Nov 2026): what went in and out, the loss, the green lot, the roast data
  // that was recorded, notes, photos and kg by product (roast_lot_detail). Only for the Producción area.
  router.get('/:businessId/produccion/tostados/:eventId', async (req, res) => {
    try {
      const eventId = String(req.params.eventId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) return res.status(400).json({ error: 'Lote de tostado no válido.' });
      if (!(await tieneArea(req, 'production'))) return res.status(403).json({ error: 'Producción no es de tus áreas.' });
      const r = await db(req, 'rpc/roast_lot_detail', { method: 'POST', body: { p_business_id: req.admin.farmId, p_event_id: eventId } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ tostado: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // Green lots (General Manager, 4 Nov 2026, "Yes, as recommended" after the meeting on green lots). Owners only, decided
  // by the database: the compras that can join the Blend lot, Agregar café al lote (milled coffee with its compras,
  // parchment in, green out, Quality's approval and cost) and Cerrar lote (only after a count of 0 kg).
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const numero = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const ref = v => (typeof v === 'string' ? v.slice(0, 80) : null);
  // The detail of a green lot (4 Nov 2026): data, product, its compras with their estimated green, additions and closing, last roasts (green_lot_detail_v3).
  router.get('/:businessId/produccion/lotes-verdes/:id', async (req, res) => {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: 'Lote no válido.' });
    try {
      if (!(await tieneArea(req, 'production'))) return res.status(403).json({ error: 'Producción no es de tus áreas.' });
      const r = await db(req, 'rpc/green_lot_detail_v3', { method: 'POST', body: { p_business_id: req.admin.farmId, p_green_lot_id: req.params.id } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ lote: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });
  router.get('/:businessId/produccion/lotes-verdes/:id/compras', async (req, res) => {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: 'Lote no válido.' });
    try {
      const r = await db(req, 'rpc/green_lot_compras_v2', { method: 'POST', body: { p_business_id: req.admin.farmId, p_green_lot_id: req.params.id } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ compras: Array.isArray(r.data) ? r.data : [] });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });
  router.post('/:businessId/produccion/lotes-verdes/:id/agregar', async (req, res) => {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: 'Lote no válido.' });
    const b = req.body || {};
    const compras = Array.isArray(b.compras) ? b.compras.filter(c => typeof c === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(c)).slice(0, 100) : [];
    try {
      const r = await db(req, 'rpc/add_green_kg', {
        method: 'POST',
        body: {
          p_business_id: req.admin.farmId, p_green_lot_id: req.params.id, p_green_kg: numero(b.kgVerde), p_parchment_kg: numero(b.kgPergamino),
          p_compras: compras, p_quality_ok: b.calidadAprobo === true, p_cost_total: numero(b.costo),
          p_note: typeof b.nota === 'string' ? b.nota.slice(0, 300) : null, p_client_ref: ref(b.clientRef),
        },
      });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ ok: true, resultado: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });
  router.post('/:businessId/produccion/lotes-verdes/:id/cerrar', async (req, res) => {
    if (!UUID.test(String(req.params.id))) return res.status(400).json({ error: 'Lote no válido.' });
    const b = req.body || {};
    try {
      const r = await db(req, 'rpc/close_green_lot', {
        method: 'POST',
        body: {
          p_business_id: req.admin.farmId, p_green_lot_id: req.params.id, p_counted_kg: numero(b.kgContados),
          p_reason: typeof b.motivo === 'string' ? b.motivo.slice(0, 300) : null, p_client_ref: ref(b.clientRef),
        },
      });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ ok: true, resultado: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  router.get('/:businessId/proveedores/:id/reporte', async (req, res) => {
    try {
      const r = await db(req, 'rpc/party_report', { method: 'POST', body: { p_business_id: req.admin.farmId, p_party_id: String(req.params.id).slice(0, 40) } });
      if (!r.ok) return sendDbError(res, r);
      return res.json({ reporte: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // One purchase with its detail; only for the Compras area.
  router.get('/:businessId/compras/:id', async (req, res) => {
    try {
      if (!(await tieneArea(req, 'sourcing'))) return res.status(403).json({ error: 'Compras no es de tus áreas.' });
      const r = await db(req, 'rpc/purchase_detail_v4', { method: 'POST', body: { p_business_id: req.admin.farmId, p_delivery_id: String(req.params.id).slice(0, 40) } });
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

  // ── Evidence (3 Nov 2026): a photo or PDF of the voucher or receipt of a compra, gasto or adelanto ──
  // The file goes to the private bucket operations-evidence. The database decides first, with the person's own
  // login, that they may (owners) and in which folder; only then the server stores it with the service key.
  const BUCKET = 'operations-evidence';
  const TIPOS_EVIDENCIA = new Set(['purchase', 'expense', 'advance_request', 'advance']);
  const ARCHIVOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
  const MAX_BYTES = 8 * 1024 * 1024;

  /** The first bytes must match the declared type, so a renamed file is refused. */
  function tipoReal(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    return null;
  }

  async function storage(path, { method = 'POST', body, contentType = 'application/json' } = {}) {
    const res = await fetchImpl(`${supabaseUrl()}/storage/v1/${path}`, {
      method,
      headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, 'Content-Type': contentType },
      body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { message: text }; }
    return { ok: res.ok, status: res.status, data };
  }

  router.post('/:businessId/evidencias', async (req, res) => {
    const b = req.body || {};
    const tipo = TIPOS_EVIDENCIA.has(b.tipo) ? b.tipo : null;
    const id = typeof b.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(b.id) ? b.id : null;
    if (!tipo || !id) return res.status(400).json({ error: 'Falta a qué registro va la evidencia.' });
    if (!serviceKey()) return res.status(503).json({ error: 'Evidencias no configuradas en el servidor' });
    const archivo = Buffer.from(typeof b.archivoBase64 === 'string' ? b.archivoBase64.replace(/^data:[^,]*,/, '') : '', 'base64');
    if (!archivo.length) return res.status(400).json({ error: 'Falta la foto o el PDF.' });
    if (archivo.length > MAX_BYTES) return res.status(400).json({ error: 'El archivo pesa más de 8 MB.' });
    const mime = tipoReal(archivo);
    if (!mime) return res.status(400).json({ error: 'Sólo fotos (JPG o PNG) o PDF.' });
    try {
      const carpeta = await db(req, 'rpc/evidence_folder', { method: 'POST', body: { p_kind: tipo, p_target_id: id, p_business_id: req.admin.farmId } });
      if (!carpeta.ok) return sendDbError(res, carpeta);
      const path = `${carpeta.data}${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ARCHIVOS[mime]}`;
      const subida = await storage(`object/${BUCKET}/${path}`, { body: archivo, contentType: mime });
      if (!subida.ok) return res.status(502).json({ error: 'No se pudo guardar el archivo. Inténtalo de nuevo.' });
      const r = await db(req, 'rpc/admin_add_evidence', {
        method: 'POST',
        body: {
          p_kind: tipo, p_target_id: id, p_path: path, p_mime: mime, p_size: archivo.length,
          p_note: typeof b.nota === 'string' ? b.nota.slice(0, 300) : null, p_business_id: req.admin.farmId,
          p_client_ref: typeof b.clientRef === 'string' ? b.clientRef.slice(0, 80) : null,
        },
      });
      if (!r.ok) {
        await storage(`object/${BUCKET}`, { method: 'DELETE', body: { prefixes: [path] } }).catch(() => {});
        return sendDbError(res, r);
      }
      return res.json({ ok: true, evidencia: r.data });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  // The evidence of one record with links that work for 10 minutes; the database gives the rows only to owners.
  router.get('/:businessId/evidencias', async (req, res) => {
    const tipo = TIPOS_EVIDENCIA.has(req.query.tipo) ? req.query.tipo : null;
    const id = typeof req.query.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(req.query.id) ? req.query.id : null;
    if (!tipo || !id) return res.status(400).json({ error: 'Falta el registro.' });
    try {
      const r = await db(req, 'rpc/evidence_of', { method: 'POST', body: { p_business_id: req.admin.farmId, p_kind: tipo, p_target_id: id } });
      if (!r.ok) return sendDbError(res, r);
      const filas = Array.isArray(r.data) ? r.data : [];
      if (!filas.length || !serviceKey()) return res.json({ evidencias: filas.map(({ path, ...e }) => e) });
      const firmas = await storage(`object/sign/${BUCKET}`, { body: { expiresIn: 600, paths: filas.map(e => e.path) } });
      const porPath = new Map((firmas.ok && Array.isArray(firmas.data) ? firmas.data : [])
        .filter(f => f && f.signedURL).map(f => [f.path, f.signedURL.startsWith('http') ? f.signedURL : `${supabaseUrl()}/storage/v1${f.signedURL}`]));
      return res.json({ evidencias: filas.map(({ path, ...e }) => ({ ...e, url: porPath.get(path) || null })) });
    } catch (err) {
      return res.status(502).json({ error: 'No se pudo conectar con la base de datos' });
    }
  });

  return router;
}

module.exports = { createAdministracionRouter, FORMS, PENDIENTES, toParams };
