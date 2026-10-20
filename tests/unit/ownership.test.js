const { createOwnership, resolveMode } = require('../../core/services/ownership');

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORDER_A = U(1);   // belongs to farm-A
const ORDER_B = U(2);   // belongs to farm-B
const PAY_A = U(11);    // payment of order A
const PAY_B = U(12);    // payment of order B
const PROOF_A = U(21);  // proof of PAY_A
const PROOF_B = U(22);  // proof of PAY_B
const PROD_A = U(31), PROD_B = U(32);
const PRES_A = U(41), PRES_B = U(42);
const LOT_A = U(51), LOT_B = U(52);

/** In-memory PostgREST stand-in: understands only the filters this module uses. */
function fakeGet({ failOn } = {}) {
  const tables = {
    orders: [{ id: ORDER_A, order_number: 'ORD-A' }, { id: ORDER_B, order_number: 'ORD-B' }, { id: U(3), order_number: 'ORD-EMPTY' }],
    order_items: [{ order_id: ORDER_A, farm_id: 'farm-A' }, { order_id: ORDER_B, farm_id: 'farm-B' }],
    order_payments: [{ id: PAY_A, order_id: ORDER_A }, { id: PAY_B, order_id: ORDER_B }],
    order_payment_proofs: [
      { id: PROOF_A, payment_id: PAY_A, order_payments: { order_id: ORDER_A } },
      { id: PROOF_B, payment_id: PAY_B, order_payments: [{ order_id: ORDER_B }] },
    ],
    products: [{ id: PROD_A, farm_id: 'farm-A' }, { id: PROD_B, farm_id: 'farm-B' }],
    product_presentations: [{ id: PRES_A, product_id: PROD_A }, { id: PRES_B, product_id: PROD_B }],
    green_lots: [{ id: LOT_A, roastery_farm_id: 'farm-A' }, { id: LOT_B, roastery_farm_id: 'farm-B' }],
  };
  const fn = jest.fn(async (table, params = {}) => {
    if (failOn === table) throw new Error('db down');
    return tables[table].filter(row => Object.entries(params)
      .filter(([k]) => k !== 'select')
      .every(([k, v]) => row[k] === String(v).replace(/^eq\./, '')));
  });
  return fn;
}

const quietLog = () => ({ log: jest.fn(), error: jest.fn() });
const negocios = { 'BIZ-A': { farmId: 'farm-A' }, 'BIZ-LEGACY': {} };
const getNegocio = id => negocios[id] || null;

function build(mode, opts) {
  const get = fakeGet(opts); const log = quietLog();
  return { own: createOwnership({ get, getNegocio, mode, log }), get, log };
}
function makeRes() {
  const res = {};
  res.status = jest.fn(code => { res.statusCode = code; return res; });
  res.json = jest.fn(body => { res.body = body; return res; });
  return res;
}
const mkReq = (params, body) => ({ method: 'GET', baseUrl: '/api/pedidos', route: { path: '/x' }, params: { businessId: 'BIZ-A', ...params }, body });

describe('resolveMode', () => {
  test('default off; invalid never blocks', () => {
    expect(resolveMode(undefined).mode).toBe('off');
    expect(resolveMode('block').mode).toBe('block');
    const r = resolveMode('blokc');
    expect(r.mode).toBe('log'); expect(r.warning).toBeTruthy();
  });
});

describe('checks', () => {
  const { own } = build('block');

  test('order: own ok, foreign fails, missing passes through, no-items fails closed', async () => {
    expect((await own.checkOrder(ORDER_A, 'farm-A')).ok).toBe(true);
    expect((await own.checkOrder('ORD-A', 'farm-A')).ok).toBe(true);          // by order number
    expect(await own.checkOrder(ORDER_B, 'farm-A')).toEqual({ ok: false, reason: 'foreign-order' });
    expect((await own.checkOrder('ORD-NOPE', 'farm-A')).reason).toBe('not-found');
    expect(await own.checkOrder('ORD-EMPTY', 'farm-A')).toEqual({ ok: false, reason: 'order-without-items' });
  });

  test('payment must belong to the order in the URL', async () => {
    expect((await own.checkPaymentInOrder(PAY_A, ORDER_A)).ok).toBe(true);
    expect(await own.checkPaymentInOrder(PAY_B, ORDER_A)).toEqual({ ok: false, reason: 'payment-of-another-order' });
    expect((await own.checkPaymentInOrder('not-a-uuid', ORDER_A)).reason).toBe('not-found');
  });

  test('evidence must belong to a payment of the order in the URL (object and array embed)', async () => {
    expect((await own.checkProofInOrder(PROOF_A, ORDER_A)).ok).toBe(true);
    expect((await own.checkProofInOrder(PROOF_B, ORDER_B)).ok).toBe(true);
    expect(await own.checkProofInOrder(PROOF_B, ORDER_A)).toEqual({ ok: false, reason: 'evidence-of-another-order' });
  });

  test('product, presentation and lot', async () => {
    expect((await own.checkProduct(PROD_A, 'farm-A')).ok).toBe(true);
    expect((await own.checkProduct(PROD_B, 'farm-A')).reason).toBe('foreign-product');
    expect((await own.checkProduct('PROD-001', 'farm-A')).reason).toBe('legacy-id');
    expect((await own.checkPresentationInProduct(PRES_A, PROD_A)).ok).toBe(true);
    expect((await own.checkPresentationInProduct(PRES_B, PROD_A)).reason).toBe('presentation-of-another-product');
    expect((await own.checkLot(LOT_A, 'farm-A')).ok).toBe(true);
    expect((await own.checkLot(LOT_B, 'farm-A')).reason).toBe('foreign-lot');
    expect((await own.checkLot(undefined, 'farm-A')).reason).toBe('not-found');
  });

  test('does not query the database for malformed ids', async () => {
    const b = build('block');
    await b.own.checkProduct('x', 'farm-A'); await b.own.checkLot('x', 'farm-A');
    await b.own.checkPaymentInOrder('x', ORDER_A);
    expect(b.get).not.toHaveBeenCalledWith('products', expect.anything());
    expect(b.get).not.toHaveBeenCalledWith('green_lots', expect.anything());
    expect(b.get).not.toHaveBeenCalledWith('order_payments', expect.anything());
  });
});

describe('guards', () => {
  test('off (default): no queries, passes', async () => {
    const b = build(undefined);
    const next = jest.fn();
    await b.own.guards.order(mkReq({ pedidoId: ORDER_B }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(b.get).not.toHaveBeenCalled();
  });

  test('log: foreign order passes but is logged without ids', async () => {
    const b = build('log');
    const res = makeRes(); const next = jest.fn();
    await b.own.guards.order(mkReq({ pedidoId: ORDER_B }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    const line = b.log.log.mock.calls[0][0];
    expect(line).toContain('reason=foreign-order');
    expect(line).not.toContain(ORDER_B);
    expect(line).not.toContain('BIZ-A');
  });

  describe('block', () => {
    test('foreign order -> 404', async () => {
      const b = build('block'); const res = makeRes(); const next = jest.fn();
      await b.own.guards.order(mkReq({ pedidoId: ORDER_B }), res, next);
      expect(res.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
    });

    test('own order -> next', async () => {
      const b = build('block'); const next = jest.fn();
      await b.own.guards.order(mkReq({ pedidoId: ORDER_A }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    test('own order but payment of another order -> 404', async () => {
      const b = build('block'); const res = makeRes(); const next = jest.fn();
      await b.own.guards.orderPayment(mkReq({ pedidoId: ORDER_A, pagoId: PAY_B }), res, next);
      expect(res.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
    });

    test('own order but evidence of another order -> 404', async () => {
      const b = build('block'); const res = makeRes(); const next = jest.fn();
      await b.own.guards.orderEvidence(mkReq({ pedidoId: ORDER_A, evidenciaId: PROOF_B }), res, next);
      expect(res.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
    });

    test('foreign order + own payment id still blocked (order checked first)', async () => {
      const b = build('block'); const res = makeRes();
      await b.own.guards.orderPayment(mkReq({ pedidoId: ORDER_B, pagoId: PAY_A }), res, jest.fn());
      expect(res.statusCode).toBe(404);
    });

    test('lot id comes from the body and businessId from the body too', async () => {
      const b = build('block');
      const bad = makeRes(); const nextBad = jest.fn();
      await b.own.guards.lotInBody({ ...mkReq({}, { businessId: 'BIZ-A', green_lot_id: LOT_B }), params: {} }, bad, nextBad);
      expect(bad.statusCode).toBe(404); expect(nextBad).not.toHaveBeenCalled();
      const next = jest.fn();
      await b.own.guards.lotInBody({ ...mkReq({}, { businessId: 'BIZ-A', green_lot_id: LOT_A }), params: {} }, makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    test('product and presentation guards', async () => {
      const b = build('block');
      const r1 = makeRes();
      await b.own.guards.product(mkReq({ productId: PROD_B }), r1, jest.fn());
      expect(r1.statusCode).toBe(404);
      const r2 = makeRes();
      await b.own.guards.presentation(mkReq({ productId: PROD_A, presentationId: PRES_B }), r2, jest.fn());
      expect(r2.statusCode).toBe(404);
      const next = jest.fn();
      await b.own.guards.presentation(mkReq({ productId: PROD_A, presentationId: PRES_A }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    test('lookup failure -> 503 (fail closed)', async () => {
      const b = build('block', { failOn: 'orders' }); const res = makeRes(); const next = jest.fn();
      await b.own.guards.order(mkReq({ pedidoId: ORDER_A }), res, next);
      expect(res.statusCode).toBe(503); expect(next).not.toHaveBeenCalled();
    });

    test('missing object passes so the handler answers its usual 404', async () => {
      const b = build('block'); const next = jest.fn();
      await b.own.guards.order(mkReq({ pedidoId: 'ORD-NOPE' }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    test('unknown business or business without farm is skipped', async () => {
      const b = build('block');
      const n1 = jest.fn(); const n2 = jest.fn();
      await b.own.guards.order(mkReq({ businessId: 'BIZ-X', pedidoId: ORDER_B }), makeRes(), n1);
      await b.own.guards.order(mkReq({ businessId: 'BIZ-LEGACY', pedidoId: ORDER_B }), makeRes(), n2);
      expect(n1).toHaveBeenCalled(); expect(n2).toHaveBeenCalled();
      expect(b.get).not.toHaveBeenCalled();
    });
  });

  test('lookup failure in log mode does not block', async () => {
    const b = build('log', { failOn: 'orders' }); const next = jest.fn();
    await b.own.guards.order(mkReq({ pedidoId: ORDER_A }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(b.log.error).toHaveBeenCalled();
  });
});
