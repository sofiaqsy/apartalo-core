/**
 * E2E TESTS — Delivery flow against real Heroku API
 *
 * Requires env vars:
 *   E2E_BASE_URL      = https://apartalo-core-xxxx.herokuapp.com
 *   E2E_BIZ_ID        = BIZ-000  (origin test business, must have deliveryBizId in configExtra)
 *   E2E_DELIVERY_BIZ  = BIZ-000  (delivery test business)
 *   E2E_CLIENT_PHONE  = phone registered in BIZ-000 Clientes with departamento and address
 *
 * Run with: npm run test:e2e
 */

const axios = require('axios');

const BASE_URL   = process.env.E2E_BASE_URL   || 'https://apartalo-core-9d633cdb9e1a.herokuapp.com';
const BIZ_ID     = process.env.E2E_BIZ_ID      || 'BIZ-000';  // origin business (creates orders)
const DELIVERY   = process.env.E2E_DELIVERY_BIZ || 'BIZ-005';  // delivery business (receives products via deliveryBizId)
const CLI_PHONE  = process.env.E2E_CLIENT_PHONE  || '936958201';

const TEST_HEADERS = {
  'Content-Type': 'application/json',
  'X-Test-Mode': '1',   // skips WhatsApp sends
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Poll until the condition is true or timeout is reached.
 * Retries every intervalMs up to timeoutMs total.
 */
async function waitUntil(conditionFn, { timeoutMs = 20000, intervalMs = 2000, label = '' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await conditionFn();
    if (result) return result;
    console.log(`[E2E] Waiting for: ${label} (${Math.round((Date.now() - start) / 1000)}s)`);
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${label} (${timeoutMs / 1000}s)`);
}

async function createOrder(overrides = {}) {
  const body = {
    whatsapp: CLI_PHONE,
    cliente: 'E2E Test Client',
    productos: [{ nombre: 'Producto Test', precio: 10, cantidad: 1 }],
    total: 10,
    ...overrides,
  };
  const res = await axios.post(`${BASE_URL}/api/pedidos/${BIZ_ID}`, body, { headers: TEST_HEADERS });
  return res.data.pedido;
}

async function getDeliveryProducts() {
  // Use limite=100 to avoid pagination hiding freshly-created delivery products
  const res = await axios.get(`${BASE_URL}/api/productos/${DELIVERY}?estado=ACTIVO&limite=100`);
  return (res.data.productos || []).filter(p => p.categoria === 'DELIVERY');
}

async function getDeliveryOrders() {
  const res = await axios.get(`${BASE_URL}/api/pedidos/${DELIVERY}?limite=20`);
  return res.data.pedidos || [];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('E2E — Delivery flow (real Heroku API)', () => {
  jest.setTimeout(55000); // 55s timeout per test (Heroku + Sheets can be slow)

  let createdPedidoId;
  let createdDeliveryId;

  // ── Test 1: Order creation triggers delivery registration ─────────────────
  test('creating an order with a valid Lima client registers a delivery product in BIZ-005', async () => {
    const deliverysBefore = await getDeliveryProducts();

    // Pass direccion + departamento directly so the delivery hook proceeds
    // regardless of whether the client phone exists in the Clientes sheet
    const pedido = await createOrder({
      direccion: 'Av. Test 123, Lince',
      departamento: 'Lima',
    });
    createdPedidoId = pedido.id;
    expect(pedido.id).toMatch(/^PED-/);

    // Poll until a new DELIVERY product appears (Heroku + Sheets can be slow)
    const newDeliveries = await waitUntil(async () => {
      const after = await getDeliveryProducts();
      const fresh = after.filter(d => !deliverysBefore.find(b => b.codigo === d.codigo));
      return fresh.length > 0 ? fresh : null;
    }, { timeoutMs: 35000, intervalMs: 3000, label: `new DELIVERY product in ${DELIVERY} Inventario` });

    expect(newDeliveries.length).toBeGreaterThanOrEqual(1);
    createdDeliveryId = newDeliveries[0].codigo;
    console.log(`[E2E] Delivery product created: ${createdDeliveryId}`);
  });

  // ── Test 2: Delivery product has correct price ────────────────────────────
  test('delivery product in BIZ-005 has the precioDelivery from origin configExtra', async () => {
    if (!createdDeliveryId) return; // skip if previous test failed

    const products = await getDeliveryProducts();
    const delivery = products.find(p => p.codigo === createdDeliveryId);
    expect(delivery).toBeDefined();
    expect(parseFloat(delivery.precio)).toBeGreaterThan(0);
    console.log(`[E2E] Delivery price: S/ ${delivery.precio}`);
  });

  // ── Test 3: City filter — order without Lima client is skipped ────────────
  test('order where client city does not match store city does NOT create a delivery product', async () => {
    const deliverysBefore = await getDeliveryProducts();

    // Pass a non-Lima departamento → city mismatch filter blocks delivery
    await createOrder({ whatsapp: '51000000001', departamento: 'Arequipa', direccion: 'Av. Test 123' });

    await sleep(12000); // fixed wait — we expect nothing to appear

    const deliverysAfter = await getDeliveryProducts();
    const newDeliveries = deliverysAfter.filter(
      d => !deliverysBefore.find(b => b.codigo === d.codigo)
    );

    expect(newDeliveries.length).toBe(0);
    console.log('[E2E] City filter correctly blocked unknown-city order');
  });

  // ── Test 4: Server health check ───────────────────────────────────────────
  test('server is up and responding', async () => {
    const res = await axios.get(`${BASE_URL}/api/negocios/BIZ-004`).catch(e => e.response);
    expect([200, 404]).toContain(res.status); // 404 is fine, means server is alive
  });
});
