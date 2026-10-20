/**
 * OWNERSHIP: does the object in the URL belong to the business in the URL?
 *
 * Passing "is a member of business A" must not let anyone touch business B's order,
 * payment, evidence, product, presentation or green lot just by knowing its id.
 *
 * OWNERSHIP_MODE:
 *   off    (default) no queries, no effect: behaviour is exactly as before.
 *   log    runs the checks and logs "would-block" lines; never blocks.
 *   block  answers 404 for foreign objects (indistinguishable from a missing one)
 *          and 503 if the check itself fails (fail closed).
 *
 * How an object's farm is determined (verified in supabase-service.js):
 *   - orders have no farm_id; their farm is the farm_id of their order_items
 *   - products.farm_id, green_lots.roastery_farm_id
 *   - payments belong to an order; evidences (order_payment_proofs) belong to a payment
 *
 * "Not found" passes through (ok) so the handler produces its normal 404.
 * Logs contain the kind, the reason and a route pattern; never ids or personal data.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ['off', 'log', 'block'];

function resolveMode(raw) {
  const value = String(raw == null || raw === '' ? 'off' : raw).trim().toLowerCase();
  return MODES.includes(value) ? { mode: value } : { mode: 'log', warning: `OWNERSHIP_MODE="${String(raw).slice(0, 20)}" no es válido; se usa "log"` };
}

/**
 * @param {object} deps
 * @param {(path:string, params?:object)=>Promise<any>} deps.get  PostgREST GET helper
 * @param {(businessId:string)=>object|null} deps.getNegocio
 * @param {string} [deps.mode]
 * @param {object} [deps.log]
 */
function createOwnership({ get, getNegocio, mode, log = console } = {}) {
  const resolved = resolveMode(mode);
  if (resolved.warning) log.error(`[OWNERSHIP] ${resolved.warning}`);
  const active = resolved.mode;

  const ok = (reason = 'ok') => ({ ok: true, reason });
  const fail = reason => ({ ok: false, reason });

  // ── Lookups ────────────────────────────────────────────────────────────────

  /** order number ("ORD-...") or uuid -> { id, farmIds:Set } | null */
  async function loadOrder(orderRef) {
    const ref = String(orderRef || '');
    if (!ref) return null;
    const isUuid = UUID.test(ref);
    const rows = await get('orders', { ...(isUuid ? { id: `eq.${ref}` } : { order_number: `eq.${ref}` }), select: 'id' });
    if (!rows || !rows[0]) return null;
    const items = await get('order_items', { order_id: `eq.${rows[0].id}`, select: 'farm_id' });
    return { id: rows[0].id, farmIds: new Set((items || []).map(i => i.farm_id).filter(Boolean)) };
  }

  async function checkOrder(orderRef, farmId) {
    const order = await loadOrder(orderRef);
    if (!order) return ok('not-found');
    if (order.farmIds.size === 0) return fail('order-without-items');
    return order.farmIds.has(farmId) ? ok() : fail('foreign-order');
  }

  async function checkPaymentInOrder(paymentId, orderRef) {
    if (!UUID.test(String(paymentId || ''))) return ok('not-found');
    const order = await loadOrder(orderRef);
    if (!order) return ok('not-found');
    const rows = await get('order_payments', { id: `eq.${paymentId}`, select: 'order_id' });
    if (!rows || !rows[0]) return ok('not-found');
    return rows[0].order_id === order.id ? ok() : fail('payment-of-another-order');
  }

  async function checkProofInOrder(proofId, orderRef) {
    if (!UUID.test(String(proofId || ''))) return ok('not-found');
    const order = await loadOrder(orderRef);
    if (!order) return ok('not-found');
    const rows = await get('order_payment_proofs', { id: `eq.${proofId}`, select: 'payment_id,order_payments(order_id)' });
    if (!rows || !rows[0]) return ok('not-found');
    const pay = rows[0].order_payments;
    const orderId = Array.isArray(pay) ? pay[0] && pay[0].order_id : pay && pay.order_id;
    return orderId === order.id ? ok() : fail('evidence-of-another-order');
  }

  async function checkProduct(productId, farmId) {
    if (!UUID.test(String(productId || ''))) return ok('legacy-id');     // sheet-style code: scoped by the adapter
    const rows = await get('products', { id: `eq.${productId}`, select: 'farm_id' });
    if (!rows || !rows[0]) return ok('not-found');
    return rows[0].farm_id === farmId ? ok() : fail('foreign-product');
  }

  async function checkPresentationInProduct(presentationId, productId) {
    if (!UUID.test(String(presentationId || '')) || !UUID.test(String(productId || ''))) return ok('not-found');
    const rows = await get('product_presentations', { id: `eq.${presentationId}`, select: 'product_id' });
    if (!rows || !rows[0]) return ok('not-found');
    return rows[0].product_id === productId ? ok() : fail('presentation-of-another-product');
  }

  async function checkLot(lotId, farmId) {
    if (!UUID.test(String(lotId || ''))) return ok('not-found');
    const rows = await get('green_lots', { id: `eq.${lotId}`, select: 'roastery_farm_id' });
    if (!rows || !rows[0]) return ok('not-found');
    return rows[0].roastery_farm_id === farmId ? ok() : fail('foreign-lot');
  }

  // ── Express glue ───────────────────────────────────────────────────────────

  /**
   * Middleware factory. `check(req, farmId)` returns a result (or an array of results).
   * Kept private to this module; routes use the named guards below.
   */
  function makeGuard(kind, check) {
    return async function ownershipGuard(req, res, next) {
      if (active === 'off') return next();

      // businessId comes from the path for most routes and from the body for roast-event creation.
      const businessId = (req.params && req.params.businessId) || (req.body && req.body.businessId);
      const negocio = businessId ? getNegocio(businessId) : null;
      // Unknown business: the handler answers 404. Business without a farm (legacy sheet): nothing to check.
      if (!negocio || !negocio.farmId) return next();

      let results;
      try {
        const r = await check(req, negocio.farmId);
        results = Array.isArray(r) ? r : [r];
      } catch (err) {
        log.error(`[OWNERSHIP] kind=${kind} la comprobación falló: ${err && err.message}`);
        if (active === 'block') return res.status(503).json({ error: 'No se pudo verificar la pertenencia del recurso' });
        return next();
      }

      const bad = results.find(r => !r.ok);
      if (!bad) return next();

      log.log(`[OWNERSHIP-${active.toUpperCase()}] would-block kind=${kind} reason=${bad.reason} ${req.method} ${String(req.baseUrl || '')}${String(req.route && req.route.path || '').slice(0, 80)}`);
      if (active === 'block') return res.status(404).json({ error: 'Recurso no encontrado' });
      return next();
    };
  }

  const guards = {
    /** :pedidoId must belong to the business */
    order: makeGuard('order', (req, farmId) => checkOrder(req.params.pedidoId, farmId)),
    /** :pedidoId belongs to the business AND :pagoId belongs to that order */
    orderPayment: makeGuard('payment', async (req, farmId) =>
      [await checkOrder(req.params.pedidoId, farmId), await checkPaymentInOrder(req.params.pagoId, req.params.pedidoId)]),
    /** :pedidoId belongs to the business AND :evidenciaId belongs to that order */
    orderEvidence: makeGuard('evidence', async (req, farmId) =>
      [await checkOrder(req.params.pedidoId, farmId), await checkProofInOrder(req.params.evidenciaId, req.params.pedidoId)]),
    /** body.green_lot_id belongs to the business (roast event creation) */
    lotInBody: makeGuard('lot', (req, farmId) => checkLot(req.body && req.body.green_lot_id, farmId)),
    /** :productId belongs to the business */
    product: makeGuard('product', (req, farmId) => checkProduct(req.params.productId, farmId)),
    /** :productId belongs to the business AND :presentationId belongs to that product */
    presentation: makeGuard('presentation', async (req, farmId) =>
      [await checkProduct(req.params.productId, farmId), await checkPresentationInProduct(req.params.presentationId, req.params.productId)]),
  };

  return {
    mode: active,
    checkOrder, checkPaymentInOrder, checkProofInOrder, checkProduct, checkPresentationInProduct, checkLot,
    guards,
  };
}

module.exports = { createOwnership, resolveMode, UUID, MODES };
