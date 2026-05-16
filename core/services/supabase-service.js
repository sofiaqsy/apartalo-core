const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos');
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabase;
}

// ─── FARMS ────────────────────────────────────────────────────────────────────

async function getFarm(farmId) {
  const { data, error } = await getClient()
    .from('farms')
    .select('*')
    .eq('id', farmId)
    .single();
  if (error) throw error;
  return data;
}

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

async function getProducts(farmId) {
  const { data, error } = await getClient()
    .from('products')
    .select('id, name, description, unit, price_cents, b2b_price_cents, currency, stock, min_order_qty, status, images')
    .eq('farm_id', farmId)
    .eq('status', 'active')
    .order('name');
  if (error) throw error;
  return data;
}

async function getProductById(productId) {
  const { data, error } = await getClient()
    .from('products')
    .select('id, farm_id, name, description, unit, price_cents, b2b_price_cents, currency, stock, min_order_qty, status, images')
    .eq('id', productId)
    .single();
  if (error) throw error;
  return data;
}

// ─── CUSTOMERS (profiles) ─────────────────────────────────────────────────────

async function getCustomerByPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  const { data, error } = await getClient()
    .from('profiles')
    .select('id, email, full_name, phone, role')
    .eq('phone', cleaned)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createCustomer({ fullName, phone, email }) {
  const cleaned = phone.replace(/\D/g, '');
  const { data, error } = await getClient()
    .from('profiles')
    .insert({ full_name: fullName, phone: cleaned, email: email || `${cleaned}@whatsapp.apartalo.co`, role: 'customer' })
    .select('id, email, full_name, phone')
    .single();
  if (error) throw error;
  return data;
}

async function updateCustomer(profileId, fields) {
  const { data, error } = await getClient()
    .from('profiles')
    .update(fields)
    .eq('id', profileId)
    .select('id, email, full_name, phone')
    .single();
  if (error) throw error;
  return data;
}

// ─── ORDERS ───────────────────────────────────────────────────────────────────

async function createOrder({ customer, farmId, items, shippingAddress, notes, paymentMethod, currency = 'USD' }) {
  const client = getClient();

  const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);

  const { data: order, error: orderError } = await client
    .from('orders')
    .insert({
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
    })
    .select('id, order_number')
    .single();

  if (orderError) throw orderError;

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

  const { error: itemsError } = await client.from('order_items').insert(orderItems);
  if (itemsError) throw itemsError;

  return order;
}

async function getOrdersByCustomer(customerId) {
  const { data, error } = await getClient()
    .from('orders')
    .select('id, order_number, status, total_cents, currency, created_at, order_items(product_name, quantity, unit)')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
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
