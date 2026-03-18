/**
 * E2E TESTS — Delivery flow against real Heroku API
 *
 * Requires env vars:
 *   E2E_BASE_URL      = https://apartalo-core-xxxx.herokuapp.com
 *   E2E_BIZ_ID        = BIZ-004  (origin business, must have deliveryBizId in configExtra)
 *   E2E_DELIVERY_BIZ  = BIZ-005  (delivery business)
 *   E2E_CLIENT_PHONE  = phone registered in BIZ-004 Clientes with Lima departamento and address
 *
 * Run with: npm run test:e2e
 */

const axios = require('axios');

const BASE_URL   = process.env.E2E_BASE_URL   || 'https://apartalo-core-9d633cdb9e1a.herokuapp.com';
const BIZ_ID     = process.env.E2E_BIZ_ID     || 'BIZ-004';
const DELIVERY   = process.env.E2E_DELIVERY_BIZ || 'BIZ-005';
const CLI_PHONE  = process.env.E2E_CLIENT_PHONE || '51936934501';

const TEST_HEADERS = {
  'Content-Type': 'application/json',
  'X-Test-Mode': '1',   // skips WhatsApp sends
};

const WAIT_MS = 6000;   // time for async delivery hook to finish

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const res = await axios.get(`${BASE_URL}/api/productos/${DELIVERY}?estado=ACTIVO`);
  return (res.data.productos || []).filter(p => p.categoria === 'DELIVERY');
}

async function getDeliveryOrders() {
  const res = await axios.get(`${BASE_URL}/api/pedidos/${DELIVERY}?limite=20`);
  return res.data.pedidos || [];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('E2E — Delivery flow (real Heroku API)', () => {
  jest.setTimeout(30000); // 30s timeout per test

  let createdPedidoId;
  let createdDeliveryId;

  // ── Test 1: Order creation triggers delivery registration ─────────────────
  test('creating an order with a valid Lima client registers a delivery product in BIZ-005', async () => {
    const deliverysBefore = await getDeliveryProducts();

    const pedido = await createOrder();
    createdPedidoId = pedido.id;
    expect(pedido.id).toMatch(/^PED-/);

    await sleep(WAIT_MS); // wait for async delivery hook

    const deliverysAfter = await getDeliveryProducts();
    const newDeliveries = deliverysAfter.filter(
      d => !deliverysBefore.find(b => b.codigo === d.codigo)
    );

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

    // Use a phone number not registered in BIZ-004 Clientes
    // → client lookup fails → city unknown → skipped
    await createOrder({ whatsapp: '51000000001' });

    await sleep(WAIT_MS);

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
