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

const PRODUCT_SELECT = 'id,name,description,unit,price_cents,b2b_price_cents,currency,stock,min_order_qty,min_qty_for_b2b,status,images';

async function getProducts(farmId) {
  return get('products', { farm_id: `eq.${farmId}`, status: 'eq.active', select: PRODUCT_SELECT, order: 'name.asc' });
}

async function getAllProducts(farmId) {
  return get('products', { farm_id: `eq.${farmId}`, select: PRODUCT_SELECT, order: 'name.asc' });
}

async function createProduct(farmId, { name, description, priceCents, stock, images, status, unit, b2bPriceCents, minOrderQty, minQtyForB2b }) {
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
  const body = {
    farm_id:       farmId,
    slug,
    name,
    description:   description || '',
    unit:          unit || 'unidad',
    price_cents:   priceCents || 0,
    stock:         stock || 0,
    status:        status || 'active',
    images:        images || [],
    min_order_qty: minOrderQty || 1,
    currency:      'PEN'
  };
  if (b2bPriceCents != null) body.b2b_price_cents = b2bPriceCents;
  if (minQtyForB2b != null)  body.min_qty_for_b2b = minQtyForB2b;
  const rows = await post('products', body);
  return rows[0] || null;
}

async function updateProduct(productId, fields) {
  const rows = await patch('products', { id: `eq.${productId}` }, fields);
  return rows[0] || null;
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
  // Try exact match first, then with country prefix stripped
  const attempts = [cleaned];
  if (cleaned.startsWith('51') && cleaned.length > 9) attempts.push(cleaned.slice(2)); // Peru prefix
  if (cleaned.startsWith('57') && cleaned.length > 9) attempts.push(cleaned.slice(2)); // Colombia prefix

  for (const num of attempts) {
    const rows = await get('profiles', {
      phone: `eq.${num}`,
      select: 'id,email,full_name,phone,role'
    });
    if (rows[0]) return rows[0];
  }
  return null;
}

async function createCustomer({ fullName, phone, email }) {
  const cleaned = phone.replace(/\D/g, '');
  const customerEmail = email || `${cleaned}@whatsapp.apartalo.co`;

  try {
    // profiles.id is FK to auth.users.id — must create via Admin Auth API
    const authUrl = `${base()}/auth/v1/admin/users`;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { data: authUser } = await axios.post(authUrl, {
      email: customerEmail,
      email_confirm: true,
      phone: cleaned,
      user_metadata: { full_name: fullName || '' }
    }, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    });

    // Trigger handle_new_user() auto-creates the profile — update phone explicitly
    if (authUser?.id) {
      await patch('profiles', { id: `eq.${authUser.id}` }, { phone: cleaned, full_name: fullName || '' });
      return { id: authUser.id, email: customerEmail, full_name: fullName || '', phone: cleaned, role: 'customer' };
    }
    return null;
  } catch (error) {
    console.error('[Supabase] createCustomer error:', error.response?.data || error.message);
    return null;
  }
}

async function updateCustomer(profileId, fields) {
  if (fields.phone) fields.phone = fields.phone.replace(/\D/g, '');
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

async function getCustomerById(profileId) {
  const rows = await get('profiles', {
    id: `eq.${profileId}`,
    select: 'id,email,full_name,phone,role'
  });
  return rows[0] || null;
}

async function getCustomersByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const rows = await get('profiles', {
    id: `in.(${ids.join(',')})`,
    select: 'id,email,full_name,phone,role'
  });
  return rows;
}

module.exports = {
  getFarm,
  getProducts,
  getAllProducts,
  createProduct,
  updateProduct,
  getProductById,
  getCustomerByPhone,
  getCustomerById,
  getCustomersByIds,
  createCustomer,
  updateCustomer,
  createOrder,
  getOrdersByCustomer
};
