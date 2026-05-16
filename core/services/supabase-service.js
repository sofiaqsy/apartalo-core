const axios = require('axios');

function base() {
  return (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '');
}

function headers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}

async function get(path, params = {}) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${base()}/rest/v1/${path}${qs ? '?' + qs : ''}`;
  const { data } = await axios.get(url, { headers: headers() });
  return data;
}

async function post(path, body) {
  const url = `${base()}/rest/v1/${path}`;
  const { data } = await axios.post(url, body, { headers: { ...headers(), Prefer: 'return=representation' } });
  return data;
}

async function patch(path, params, body) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${base()}/rest/v1/${path}?${qs}`;
  const { data } = await axios.patch(url, body, { headers: { ...headers(), Prefer: 'return=representation' } });
  return data;
}

// ─── FARMS ────────────────────────────────────────────────────────────────────

async function getFarm(farmId) {
  const rows = await get('farms', { 'id': `eq.${farmId}`, select: '*' });
  return rows[0] || null;
}

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

async function getProducts(farmId) {
  return get('products', {
    farm_id: `eq.${farmId}`,
    status: 'eq.active',
    select: 'id,name,description,unit,price_cents,b2b_price_cents,currency,stock,min_order_qty,status,images',
    order: 'name.asc'
  });
}

async function getProductById(productId) {
  const rows = await get('products', {
    id: `eq.${productId}`,
    select: 'id,farm_id,name,description,unit,price_cents,b2b_price_cents,currency,stock,min_order_qty,status,images'
  });
  return rows[0] || null;
}

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────

async function getCustomerByPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  const rows = await get('profiles', {
    phone: `eq.${cleaned}`,
    select: 'id,email,full_name,phone,role'
  });
  return rows[0] || null;
}

async function createCustomer({ fullName, phone, email }) {
  const cleaned = phone.replace(/\D/g, '');
  const rows = await post('profiles', {
    full_name: fullName,
    phone: cleaned,
    email: email || `${cleaned}@whatsapp.apartalo.co`,
    role: 'customer'
  });
  return rows[0] || null;
}

async function updateCustomer(profileId, fields) {
  const rows = await patch('profiles', { id: `eq.${profileId}` }, fields);
  return rows[0] || null;
}

// ─── ORDERS ───────────────────────────────────────────────────────────────────

async function createOrder({ customer, farmId, items, shippingAddress, notes, paymentMethod, currency = 'USD' }) {
  const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);

  const orders = await post('orders', {
    customer_id:      customer.id || null,
    customer_email:   customer.email,
    customer_name:    customer.fullName || customer.full_name,
    customer_phone:   customer.phone,
    shipping_address: shippingAddress,
    notes,
    subtotal_cents:   subtotalCents,
    total_cents:      subtotalCents,
    currency,
    status:           'pending_payment',
    payment_method:   paymentMethod || null
  });

  const order = orders[0];
  if (!order) throw new Error('Order creation failed');

  const orderItems = items.map(i => ({
    order_id:         order.id,
    farm_id:          farmId,
    product_id:       i.productId,
    product_name:     i.productName,
    unit:             i.unit,
    quantity:         i.quantity,
    unit_price_cents: i.unitPriceCents,
    line_total_cents: i.lineTotalCents,
    commission_rate:  i.commissionRate || 0.10,
    commission_cents: Math.round(i.lineTotalCents * (i.commissionRate || 0.10)),
    payout_cents:     Math.round(i.lineTotalCents * (1 - (i.commissionRate || 0.10)))
  }));

  await post('order_items', orderItems);
  return order;
}

async function getOrdersByCustomer(customerId) {
  return get('orders', {
    customer_id: `eq.${customerId}`,
    select: 'id,order_number,status,total_cents,currency,created_at,order_items(product_name,quantity,unit)',
    order: 'created_at.desc'
  });
}

module.exports = {
  getFarm,
  getProducts,
  getProductById,
  getCustomerByPhone,
  createCustomer,
  updateCustomer,
  createOrder,
  getOrdersByCustomer
};
