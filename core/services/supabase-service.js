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

const PRODUCT_SELECT = 'id,name,description,unit,price_cents,b2b_price_cents,currency,stock,min_order_qty,status,images,green_lot_id';

async function getProducts(farmId) {
  return get('products', { farm_id: `eq.${farmId}`, status: 'eq.active', select: PRODUCT_SELECT, order: 'name.asc' });
}

async function getAllProducts(farmId) {
  return get('products', { farm_id: `eq.${farmId}`, select: PRODUCT_SELECT, order: 'name.asc' });
}

async function createProduct(farmId, { name, description, priceCents, stock, images, status, unit, b2bPriceCents, minOrderQty }) {
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


// ─── PRODUCT PRESENTATIONS ────────────────────────────────────────────────────

const PRESENTATION_SELECT = 'id,product_id,pack_size,unit,price_cents,b2b_price_cents,min_qty_for_b2b,stock,min_order_qty,sort_order,is_default,grind';

async function getPresentations(productId) {
  const [presentations, mediaRows] = await Promise.all([
    get('product_presentations', {
      product_id: `eq.${productId}`,
      select: PRESENTATION_SELECT,
      order: 'sort_order.asc'
    }),
    get('media', {
      owner_id: `eq.${productId}`,
      select: 'presentation_id,url,role,sort_order',
      order: 'sort_order.asc'
    })
  ]);
  const presImageMap = {};
  for (const m of mediaRows) {
    if (m.presentation_id && !presImageMap[m.presentation_id]) {
      presImageMap[m.presentation_id] = m.url;
    }
  }
  return presentations.map(pp => ({ ...pp, image_url: presImageMap[pp.id] || null }));
}

async function getProductsWithPresentations(farmId) {
  const [products, salesRows] = await Promise.all([
    getAllProducts(farmId),
    get('order_items', { farm_id: `eq.${farmId}`, select: 'product_id,quantity' })
  ]);
  if (!products.length) return [];

  // Aggregate sales per product
  const salesMap = {};
  for (const row of salesRows) {
    salesMap[row.product_id] = (salesMap[row.product_id] || 0) + Number(row.quantity || 0);
  }

  const ids = products.map(p => p.id);
  const [presentations, mediaRows] = await Promise.all([
    get('product_presentations', {
      product_id: `in.(${ids.join(',')})`,
      select: PRESENTATION_SELECT,
      order: 'sort_order.asc'
    }),
    get('media', {
      owner_id: `in.(${ids.join(',')})`,
      select: 'owner_id,presentation_id,url,role,sort_order',
      order: 'sort_order.asc'
    })
  ]);

  // presentation_id set → image for that specific presentation
  // no presentation_id + role cover/profile → fallback product image
  const presImageMap = {};
  const productCoverMap = {};
  for (const m of mediaRows) {
    if (m.presentation_id && !presImageMap[m.presentation_id]) {
      presImageMap[m.presentation_id] = m.url;
    } else if (!m.presentation_id && (m.role === 'cover' || m.role === 'profile') && !productCoverMap[m.owner_id]) {
      productCoverMap[m.owner_id] = m.url;
    }
  }

  // Derive available kg from product_lot_assignments (for coffee products managed via FIFO pool).
  // Only count assignments whose output_lot belongs to a 'completed' roast event.
  const lotSelect = 'product_id,kg_assigned,kg_sold,output_lot:roast_output_lots(event:roast_events(status))';
  const lotUrl = `${base()}/rest/v1/product_lot_assignments?product_id=in.(${ids.join(',')})&select=${encodeURIComponent(lotSelect)}`;
  let lotRows = [];
  try {
    const { data } = await axios.get(lotUrl, { headers: headers() });
    lotRows = data || [];
  } catch (_) { /* non-fatal — fall back to raw stock */ }

  // availableKgByProduct[id] = kg available in the FIFO pool (only set if product has assignments)
  const availableKgByProduct = {};
  for (const a of lotRows) {
    const ev = Array.isArray(a.output_lot?.event) ? a.output_lot?.event[0] : a.output_lot?.event;
    if (ev?.status !== 'completed') continue;
    const avail = Math.max(0, Number(a.kg_assigned) - Number(a.kg_sold));
    availableKgByProduct[a.product_id] = (availableKgByProduct[a.product_id] || 0) + avail;
  }

  // Green coffee: stock comes from green_lots.current_kg (separate map, only for 'verde' grind)
  const greenKgByProduct = {};
  const greenLotIds = products.filter(p => p.green_lot_id).map(p => p.green_lot_id);
  if (greenLotIds.length > 0) {
    try {
      const glUrl = `${base()}/rest/v1/green_lots?id=in.(${greenLotIds.join(',')})&select=id,current_kg`;
      const { data: glRows } = await axios.get(glUrl, { headers: headers() });
      const glMap = {};
      for (const gl of (glRows || [])) glMap[gl.id] = Number(gl.current_kg || 0);
      for (const p of products) {
        if (p.green_lot_id && glMap[p.green_lot_id] !== undefined) {
          greenKgByProduct[p.id] = Math.max(0, glMap[p.green_lot_id]);
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  const presMap = {};
  for (const pp of presentations) {
    if (!presMap[pp.product_id]) presMap[pp.product_id] = [];
    let derivedStock = pp.stock || 0;

    const grindArr = Array.isArray(pp.grind) ? pp.grind : (pp.grind ? [pp.grind] : []);
    const isGreenPresentation = grindArr.some(g => g === 'green' || g === 'verde');

    if (isGreenPresentation && greenKgByProduct[pp.product_id] !== undefined) {
      // Verde presentation linked to a green lot → derive from green_lots.current_kg
      const availKg = greenKgByProduct[pp.product_id];
      const kgPerUnit = pp.unit === 'kg' ? Number(pp.pack_size) :
                        pp.unit === 'g'  ? Number(pp.pack_size) / 1000 : 0;
      derivedStock = kgPerUnit > 0 ? Math.max(0, Math.floor(availKg / kgPerUnit)) : 0;
    } else if (!isGreenPresentation && availableKgByProduct[pp.product_id] !== undefined) {
      // Tostado presentation → derive from roasted FIFO lot kg
      const availKg = availableKgByProduct[pp.product_id];
      const kgPerUnit = pp.unit === 'kg' ? Number(pp.pack_size) :
                        pp.unit === 'g'  ? Number(pp.pack_size) / 1000 : 0;
      derivedStock = kgPerUnit > 0 ? Math.max(0, Math.floor(availKg / kgPerUnit)) : 0;
    }
    // Verde without green_lot_id → pp.stock from DB (exact value, no derivation)

    presMap[pp.product_id].push({
      ...pp,
      stock: derivedStock,
      image_url: presImageMap[pp.id] || null
    });
  }

  return products
    .map(p => ({
      ...p,
      presentations: presMap[p.id] || [],
      image_url: productCoverMap[p.id] || null,
      totalSold: salesMap[p.id] || 0
    }))
    .sort((a, b) => b.totalSold - a.totalSold || a.name.localeCompare(b.name));
}

async function createPresentation(productId, { packSize, unit, priceCents, b2bPriceCents, minQtyForB2b, stock, minOrderQty, sortOrder, isDefault, grind }) {
  const body = {
    product_id:    productId,
    pack_size:     packSize || 1,
    unit:          unit || 'kg',
    price_cents:   priceCents || 0,
    stock:         stock || 0,
    min_order_qty: minOrderQty || 1,
    sort_order:    sortOrder || 0,
    is_default:    isDefault || false,
    grind:         grind || []
  };
  if (b2bPriceCents != null) body.b2b_price_cents = b2bPriceCents;
  if (minQtyForB2b != null) body.min_qty_for_b2b = minQtyForB2b;
  const rows = await post('product_presentations', body);
  return rows[0] || null;
}

async function updatePresentation(presentationId, fields) {
  const rows = await patch('product_presentations', { id: `eq.${presentationId}` }, fields);
  return rows[0] || null;
}

async function deletePresentation(presentationId) {
  await deleteRow('product_presentations', { id: `eq.${presentationId}` });
}

async function getRawSalesCounts(farmId) {
  return get('order_items', { farm_id: `eq.${farmId}`, select: 'product_id,quantity' });
}

// ─── AUTH / ADMIN LOGIN ───────────────────────────────────────────────────────

async function getAdminFarmsByPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  const attempts = [cleaned];
  if (cleaned.length === 9) attempts.push('51' + cleaned);
  if (cleaned.startsWith('51') && cleaned.length > 9) attempts.push(cleaned.slice(2));

  for (const num of attempts) {
    const profiles = await get('profiles', { phone: `eq.${num}`, select: 'id,full_name,phone,email,role' });
    if (!profiles[0]) continue;

    const profile = profiles[0];
    // Allowed roles in farm_members
    const members = await get('farm_members', {
      user_id: `eq.${profile.id}`,
      role:    `in.(owner,staff)`,
      select:  'farm_id,role'
    });

    if (members.length === 0) return { profile, farms: [], authorized: false };

    const farmIds = members.map(m => m.farm_id);
    const farms = await get('farms', {
      id:     `in.(${farmIds.join(',')})`,
      select: 'id,name,slug,city,location,status'
    });

    return { profile, farms, authorized: true };
  }

  return null;
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
      select: 'id,email,full_name,business_name,phone,role'
    });
    if (rows[0]) return rows[0];
  }
  return null;
}

async function createCustomer({ fullName, businessName, phone, email }) {
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
      user_metadata: { full_name: fullName || '' },
      email_change: ''
    }, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    });

    // Trigger handle_new_user() auto-creates the profile — update fields explicitly
    if (authUser?.id) {
      const profilePatch = { phone: cleaned, full_name: fullName || '' };
      if (businessName) profilePatch.business_name = businessName;
      await patch('profiles', { id: `eq.${authUser.id}` }, profilePatch);
      return { id: authUser.id, email: customerEmail, full_name: fullName || '', business_name: businessName || '', phone: cleaned, role: 'customer' };
    }
    return null;
  } catch (error) {
    const errData = error.response?.data;
    if (errData?.error_code === 'email_exists') {
      const err = new Error('Ya existe un cliente registrado con ese número de WhatsApp');
      err.code = 'duplicate_phone';
      throw err;
    }
    console.error('[Supabase] createCustomer error:', errData || error.message);
    return null;
  }
}

async function updateCustomer(profileId, fields) {
  if (fields.phone) fields.phone = fields.phone.replace(/\D/g, '');
  const rows = await patch('profiles', { id: `eq.${profileId}` }, fields);
  return rows[0] || null;
}

// ─── ORDERS ───────────────────────────────────────────────────────────────────

async function createOrder({ customer, farmId, items, shippingAddress, notes, paymentMethod, currency = 'USD', shippingCents = 0, esPreventa = false, sourceEventId = null }) {
  // ── Stock validation — skipped for pre-ventas (product not yet roasted) ──
  if (!esPreventa) for (const item of items) {
    // pack_size may not be sent by the client; fetch from DB when missing
    let packSize = item.pack_size;
    let unit     = item.unit;
    if ((!packSize || packSize === 0) && item.presentacionId) {
      try {
        const rows = await get('product_presentations', { id: `eq.${item.presentacionId}`, select: 'pack_size,unit' });
        if (rows[0]) { packSize = rows[0].pack_size; unit = rows[0].unit; }
      } catch (_) {}
    }

    const kgPerUnit = unit === 'kg' ? Number(packSize || 0) :
                      unit === 'g'  ? Number(packSize || 0) / 1000 : 0;
    const kgNeeded  = kgPerUnit * Number(item.quantity);

    // 1. Coffee (roasted): check FIFO lot pool
    if (kgNeeded > 0 && item.productId) {
      const assignUrl = `${base()}/rest/v1/product_lot_assignments?product_id=eq.${item.productId}&select=kg_assigned,kg_sold,output_lot:roast_output_lots(event:roast_events(status))`;
      const { data: assignments } = await axios.get(assignUrl, { headers: headers() });
      if (assignments?.length) {
        const availableKg = assignments.reduce((sum, a) => {
          const ev = Array.isArray(a.output_lot?.event) ? a.output_lot?.event[0] : a.output_lot?.event;
          if (ev?.status !== 'completed') return sum;
          return sum + Math.max(0, Number(a.kg_assigned) - Number(a.kg_sold));
        }, 0);
        if (kgNeeded > availableKg + 0.001) {
          throw new Error(`Stock insuficiente para "${item.productName}" (disponible: ${availableKg.toFixed(2)} kg, pedido: ${kgNeeded.toFixed(2)} kg)`);
        }
        continue; // coffee — no further stock check needed
      }
    }

    // 2. Regular stock: check presentation or product stock
    if (item.presentacionId) {
      const presRows = await get('product_presentations', { id: `eq.${item.presentacionId}`, select: 'stock,pack_size,unit' });
      const pres = presRows[0];
      if (pres && Number(pres.stock) < Number(item.quantity)) {
        throw new Error(`Stock insuficiente para "${item.productName}" (disponible: ${pres.stock} uds)`);
      }
    } else if (item.productId) {
      const prodRows = await get('products', { id: `eq.${item.productId}`, select: 'stock,name' });
      const prod = prodRows[0];
      if (prod && Number(prod.stock) < Number(item.quantity)) {
        throw new Error(`Stock insuficiente para "${item.productName}" (disponible: ${prod.stock} uds)`);
      }
    }
  }

  const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
  const shipping = Math.round(shippingCents || 0);

  const orders = await post('orders', {
    customer_id:      customer.id || null,
    customer_email:   customer.email,
    customer_name:    customer.fullName || customer.full_name,
    customer_phone:   customer.phone,
    shipping_address: shippingAddress,
    notes,
    subtotal_cents:   subtotalCents,
    shipping_cents:   shipping,
    total_cents:      subtotalCents + shipping,
    currency,
    status:           'pending',
    payment_method:   paymentMethod || null
  });

  const order = orders[0];
  if (!order) throw new Error('Order creation failed');

  // Batch-fetch pack_size + unit from product_presentations so deductStockOnConfirm
  // can calculate kgNeeded correctly for coffee FIFO deduction.
  const presIds = [...new Set(items.map(i => i.presentacionId).filter(Boolean))];
  const presPackMap = {}; // presentationId → { pack_size, unit }
  if (presIds.length) {
    try {
      const presRows = await get('product_presentations', {
        id: `in.(${presIds.join(',')})`,
        select: 'id,pack_size,unit'
      });
      for (const r of presRows) presPackMap[r.id] = { pack_size: r.pack_size, unit: r.unit };
    } catch (_) { /* non-fatal — pack_size stays null */ }
  }

  const orderItems = items.map(i => {
    const pres = i.presentacionId ? presPackMap[i.presentacionId] : null;
    return {
      order_id:         order.id,
      farm_id:          farmId,
      product_id:       i.productId,
      product_name:     i.productName,
      unit:             pres?.unit || i.unit,
      pack_size:        pres?.pack_size ?? i.packSize ?? null,
      presentation_id:  i.presentacionId || null,
      grind:            i.grind || null,
      quantity:         i.quantity,
      unit_price_cents: i.unitPriceCents,
      line_total_cents: i.lineTotalCents,
      commission_rate:  i.commissionRate || 0.10,
      commission_cents: Math.round(i.lineTotalCents * (i.commissionRate || 0.10)),
      payout_cents:     Math.round(i.lineTotalCents * (1 - (i.commissionRate || 0.10))),
      // Mark pre-venta items so deductStockOnConfirm skips them (kg already reserved)
      source_event_id:  esPreventa && sourceEventId ? sourceEventId : null,
    };
  });

  await post('order_items', orderItems);

  // Reserve kg in event_offers for pre-ventas
  if (esPreventa && sourceEventId) {
    adjustKgReservedForOrder(order.id, sourceEventId, +1).catch(err =>
      console.error('[stock] adjustKgReserved on create failed:', err.message)
    );
  }

  return order;
}

async function getOrdersByCustomer(customerId) {
  return get('orders', {
    customer_id: `eq.${customerId}`,
    select: 'id,order_number,status,subtotal_cents,shipping_cents,total_cents,currency,created_at,order_items(product_name,quantity,unit)',
    order: 'created_at.desc'
  });
}

async function getAllCustomers({ search, limit = 50 } = {}) {
  const select = 'id,email,full_name,business_name,phone,role,created_at';
  let url = `${base()}/rest/v1/profiles?select=${select}&phone=not.is.null&order=created_at.desc&limit=${limit}`;
  if (search && search.trim().length >= 2) {
    const s = encodeURIComponent(`*${search.trim()}*`);
    url += `&or=(full_name.ilike.${s},phone.ilike.${s},email.ilike.${s},business_name.ilike.${s})`;
  }
  const { data } = await axios.get(url, { headers: headers() });
  return data;
}

async function getCustomerById(profileId) {
  const rows = await get('profiles', {
    id: `eq.${profileId}`,
    select: 'id,email,full_name,business_name,phone,role'
  });
  return rows[0] || null;
}

async function getCustomersByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const rows = await get('profiles', {
    id: `in.(${ids.join(',')})`,
    select: 'id,email,full_name,business_name,phone,role'
  });
  return rows;
}

// ─── CUSTOMER PRODUCT PRICES ─────────────────────────────────────────────────

async function getCustomerPrices(customerId) {
  return get('customer_product_prices', {
    customer_id: `eq.${customerId}`,
    select: 'id,product_id,presentation_id,price_cents,updated_by,updated_at'
  });
}

async function upsertCustomerPrices(customerId, prices, updatedBy = 'APP') {
  // prices = { [presentationId]: priceValue (in currency units, not cents) }
  const presentationIds = Object.keys(prices);
  if (!presentationIds.length) return [];

  console.log(`[upsertCustomerPrices] customerId=${customerId} presentations=${presentationIds.join(',')} updatedBy=${updatedBy}`);

  // Fetch product_id for each presentation (required NOT NULL column)
  const presentations = await get('product_presentations', {
    id: `in.(${presentationIds.join(',')})`,
    select: 'id,product_id'
  });
  const productIdMap = {};
  for (const pp of presentations) productIdMap[pp.id] = pp.product_id;

  const records = presentationIds.map(presentationId => {
    const product_id = productIdMap[presentationId];
    if (!product_id) console.warn(`[upsertCustomerPrices] no product_id found for presentation ${presentationId}`);
    return {
      customer_id:     customerId,
      product_id:      product_id,
      presentation_id: presentationId,
      price_cents:     Math.round((parseFloat(prices[presentationId]) || 0) * 100),
      updated_by:      updatedBy,
      updated_at:      new Date().toISOString()
    };
  }).filter(r => r.product_id); // skip any with missing product_id

  if (!records.length) throw new Error('No se pudo resolver product_id para ninguna presentación');

  console.log(`[upsertCustomerPrices] upserting ${records.length} records`);

  const url = `${base()}/rest/v1/customer_product_prices`;
  const axios = require('axios');
  try {
    const { data } = await axios.post(url, records, {
      headers: {
        ...headers(),
        Prefer: 'resolution=merge-duplicates,return=representation'
      }
    });
    console.log(`[upsertCustomerPrices] OK saved ${data.length} records`);
    return data;
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error('[upsertCustomerPrices] Supabase error:', JSON.stringify(detail));
    throw new Error(typeof detail === 'object' ? (detail.message || detail.hint || JSON.stringify(detail)) : detail);
  }
}

async function deleteCustomerPrice(customerId, presentationId) {
  await deleteRow('customer_product_prices', {
    customer_id:     `eq.${customerId}`,
    presentation_id: `eq.${presentationId}`
  });
  return true;
}

// ─── ORDERS (extended) ────────────────────────────────────────────────────────

const ESTADO_TO_STATUS = {
  PENDIENTE: 'pending', CONFIRMADO: 'confirmed',
  EN_PREPARACION: 'preparing',
  ENVIADO: 'shipped', ENTREGADO: 'delivered',
  COMPLETADO: 'delivered', CANCELADO: 'cancelled'
};
const STATUS_TO_ESTADO = {
  pending: 'PENDIENTE', confirmed: 'CONFIRMADO', preparing: 'EN_PREPARACION',
  shipped: 'ENVIADO', delivered: 'COMPLETADO',
  cancelled: 'CANCELADO', refunded: 'CANCELADO'
};
const ESTADOPAGO_TO_PS = { PENDIENTE_PAGO: 'pending', PARCIAL: 'partial', PAGADO: 'paid' };
const PS_TO_ESTADOPAGO = { pending: 'PENDIENTE_PAGO', partial: 'PARCIAL', paid: 'PAGADO' };

function toStatus(estado)     { return ESTADO_TO_STATUS[(estado||'').toUpperCase()]  || 'pending'; }
function fromStatus(s)        { return STATUS_TO_ESTADO[s]   || 'PENDIENTE'; }
function toPayStatus(ep)      { return ESTADOPAGO_TO_PS[(ep||'').toUpperCase()] || 'pending'; }
function fromPayStatus(ps)    { return PS_TO_ESTADOPAGO[ps]  || 'PENDIENTE_PAGO'; }

function mapOrder(o, items = [], payments = []) {
  const montoCents = payments.reduce((s, p) => s + (p.amount_cents || 0), 0);
  const addr = o.shipping_address || {};
  const evidencias = payments.flatMap(p =>
    (p.order_payment_proofs || []).map(pr => ({
      id: pr.id, paymentId: p.id, url: pr.url,
      tipo: pr.source || 'APP', fecha: pr.created_at, descripcion: pr.notes || '',
      verificacion: pr.verified ? {
        estado: 'VERIFICADO', operacionBCP: pr.bcp_op_code,
        montoVerificado: pr.amount_verified_cents ? pr.amount_verified_cents / 100 : 0,
        fechaVerificado: pr.verified_at, verificadoPor: pr.verified_by
      } : null
    }))
  );
  return {
    id: o.order_number, supabaseId: o.id,
    fecha: o.created_at ? new Date(o.created_at).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '',
    hora:  o.created_at ? new Date(o.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' }) : '',
    whatsapp: o.customer_phone || '', cliente: o.customer_name || '', telefono: o.customer_phone || '',
    // Soporte para delivery_method: 'pickup' (recojo en tienda)
    ...(() => {
      const isPickup = addr.delivery_method === 'pickup';
      return {
        direccion:    addr.line1 || addr.address || (isPickup ? (addr.pickup_address || '') : ''),
        ciudad:       addr.city  || (isPickup ? (addr.pickup_city || '') : ''),
        departamento: addr.department || (isPickup ? (addr.pickup_department || '') : ''),
        tipoEnvio:    addr.tipo  || (isPickup ? 'SEDE' : ''),
        empresaEnvio: addr.courier || '',
        // Campos extra para el widget de entrega
        pickupName:   isPickup ? (addr.pickup_name || '') : '',
        pickupAddress: isPickup ? (addr.pickup_address || '') : '',
        pickupCiudad: isPickup
          ? [addr.pickup_city, addr.pickup_department].filter(Boolean).join(', ')
          : '',
      };
    })(),
    productos: items.map(i => `${i.quantity}x ${i.product_name} - S/${(i.line_total_cents/100).toFixed(2)}`).join('\n'),
    productosDetalle: items.map(i => {
      const ev = Array.isArray(i.output_lot?.event) ? i.output_lot.event[0] : i.output_lot?.event;
      const roastedAt = ev?.roasted_at
        ? new Date(ev.roasted_at).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Lima' })
        : null;
      return {
        id: i.product_id, codigo: i.product_id, nombre: i.product_name,
        cantidad: parseFloat(i.quantity), precio: i.unit_price_cents / 100,
        subtotal: i.line_total_cents / 100, unit: i.unit,
        presentacionId: i.presentation_id || null,
        grind: i.grind || null,
        roastedAt,
      };
    }),
    subtotal: (o.subtotal_cents || 0) / 100,
    costoEnvio: (o.shipping_cents || 0) / 100,
    total: o.total_cents / 100,
    estado: fromStatus(o.status), _status: o.status,
    observaciones: (o.notes || '').replace(/^\[PRE-VENTA:[^\]]*\]\s*/, ''),
    // Es preventa si tiene el prefijo en notes O si algún item tiene source_event_id
    tipo: /^\[PRE-VENTA:/.test(o.notes || '') || items.some(i => i.source_event_id)
        ? 'PREVENTA' : 'PEDIDO',
    sourceEventId: (o.notes || '').match(/^\[PRE-VENTA:([^\]]*)\]/)?.[1]
        || items.find(i => i.source_event_id)?.source_event_id
        || null,
    origen: 'APP',
    // Inferir PAGADO desde paid_at (seteo explícito de pago) no desde el status
    // — confirmar un pedido ≠ haberlo cobrado.
    estadoPago: (() => {
      const ps = o.payment_status;
      if (ps && ps !== 'pending') return fromPayStatus(ps);
      // paid_at indica que hubo un cobro real (checkout, evidencia verificada, etc.)
      if (o.paid_at) return 'PAGADO';
      return fromPayStatus(ps);
    })(),
    montoPagado: montoCents > 0 ? montoCents / 100 : (o.paid_at ? (o.total_cents || 0) / 100 : 0),
    fechaPago: o.paid_at ? new Date(o.paid_at).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '',
    pagos: payments.map(p => ({
      id: p.id, monto: p.amount_cents / 100,
      fecha: p.created_at, // UTC ISO — el cliente convierte a zona horaria local
      nota: p.notes || ''
    })),
    evidencias,
    fechaActualizacion: o.updated_at ? new Date(o.updated_at).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '',
    tracking: {
      creadoEn: o.created_at, confirmedAt: o.confirmed_at,
      preparingAt: o.preparing_at, readyAt: o.ready_at,
      shippedAt: o.shipped_at, deliveredAt: o.delivered_at
    }
  };
}

async function getOrdersByFarm(farmId, filters = {}) {
  const { vista, estado, estadoPago, cliente, fecha, pagina = 1, limite = 50 } = filters;

  const itemRows = await get('order_items', { farm_id: `eq.${farmId}`, select: 'order_id' });
  if (!itemRows.length) return { total: 0, pedidos: [], pagina: 1, totalPaginas: 0, hayMas: false };

  const orderIds = [...new Set(itemRows.map(i => i.order_id))];
  const idList = orderIds.join(',');

  const [orders, allPayments, allItems] = await Promise.all([
    get('orders',       { id: `in.(${idList})`, select: '*', order: 'created_at.desc' }),
    get('order_payments', { order_id: `in.(${idList})`, select: `*,order_payment_proofs(*)`, order: 'created_at.asc' }),
    get('order_items',  { order_id: `in.(${idList})`, select: '*' })
  ]);

  const payByOrder = {}, itemsByOrder = {};
  for (const p of allPayments) { if (!payByOrder[p.order_id]) payByOrder[p.order_id] = []; payByOrder[p.order_id].push(p); }
  for (const i of allItems)    { if (!itemsByOrder[i.order_id]) itemsByOrder[i.order_id] = []; itemsByOrder[i.order_id].push(i); }

  let pedidos = orders.map(o => mapOrder(o, itemsByOrder[o.id] || [], payByOrder[o.id] || []));

  if (vista) {
    const v = vista.toUpperCase();
    pedidos = pedidos.filter(p => {
      const s = p._status;
      const esMuestra = p.total === 0 || p.observaciones.toUpperCase().includes('MUESTRA');
      if (v === 'PENDIENTES') return !['delivered','cancelled','refunded'].includes(s) && !esMuestra;
      if (v === 'HISTORIAL')  return ['delivered','cancelled','refunded'].includes(s);
      if (v === 'POR_COBRAR') return s === 'delivered' && p.estadoPago !== 'PAGADO';
      if (v === 'PAGADOS')    return ['delivered','cancelled','refunded'].includes(s) && p.estadoPago === 'PAGADO';
      if (v === 'MUESTRAS')   return esMuestra;
      return true;
    });
  }
  if (estado)     pedidos = pedidos.filter(p => p.estado === estado.toUpperCase());
  if (estadoPago) pedidos = pedidos.filter(p => p.estadoPago === estadoPago.toUpperCase());
  if (cliente)    pedidos = pedidos.filter(p => p.cliente.toLowerCase().includes(cliente.toLowerCase()));
  if (fecha)      pedidos = pedidos.filter(p => p.fecha === fecha);

  const total = pedidos.length;
  const paginaNum = parseInt(pagina) || 1;
  const limiteNum = parseInt(limite) || 50;
  const totalPaginas = Math.ceil(total / limiteNum);
  return { total, pagina: paginaNum, totalPaginas, hayMas: paginaNum < totalPaginas, pedidos: pedidos.slice((paginaNum-1)*limiteNum, paginaNum*limiteNum) };
}

async function getOrderByIdOrNumber(idOrNumber) {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(idOrNumber);
  const param = isUUID ? { id: `eq.${idOrNumber}` } : { order_number: `eq.${idOrNumber}` };
  const orders = await get('orders', { ...param, select: '*' });
  if (!orders[0]) return null;
  const o = orders[0];
  const [items, payments] = await Promise.all([
    get('order_items', { order_id: `eq.${o.id}`, select: `*,output_lot:roast_output_lots(event:roast_events(roasted_at))` }),
    get('order_payments', { order_id: `eq.${o.id}`, select: `*,order_payment_proofs(*)`, order: 'created_at.asc' })
  ]);
  return mapOrder(o, items, payments);
}

/**
 * Increment (delta=+1) or decrement (delta=-1) kg_reserved in event_offers
 * for all items belonging to a pre-venta order.
 */
async function adjustKgReservedForOrder(supabaseOrderId, sourceEventId, delta) {
  try {
    const itemsUrl = `${base()}/rest/v1/order_items?order_id=eq.${supabaseOrderId}&select=product_id,quantity,pack_size,unit`;
    const { data: items } = await axios.get(itemsUrl, { headers: headers() });
    if (!items?.length) return;

    // Get event offers via the roast_event (avoids needing to know FK column name)
    const evUrl = `${base()}/rest/v1/roast_events?id=eq.${sourceEventId}&select=event_offers(id,product_id,kg_reserved)`;
    const { data: evRows } = await axios.get(evUrl, { headers: headers() });
    const offers = evRows?.[0]?.event_offers || [];
    if (!offers.length) return;

    const offerByProduct = {};
    for (const o of offers) offerByProduct[o.product_id] = o;

    for (const item of items) {
      const offer = offerByProduct[item.product_id];
      if (!offer) continue;

      const ps = Number(item.pack_size || 0);
      const unit = (item.unit || '').toLowerCase();
      const kgPerUnit = unit === 'kg' ? ps
                      : unit === 'g'  ? ps / 1000
                      : unit === 'lb' ? ps * 0.453592 : 0;
      const kg = kgPerUnit * Number(item.quantity);
      if (kg <= 0) continue;

      const current = Number(offer.kg_reserved || 0);
      const updated = Math.max(0, Math.round((current + delta * kg) * 1000) / 1000);
      await patch('event_offers', { id: `eq.${offer.id}` }, { kg_reserved: updated });
      offer.kg_reserved = updated; // update local cache for subsequent items on same offer
    }
  } catch (err) {
    console.error('[stock] adjustKgReservedForOrder error:', err.message);
  }
}

/**
 * Reverse deductStockOnConfirm: restore stock for fulfilled order_items.
 * Called when a previously confirmed order is cancelled.
 */
async function restoreStockItems(supabaseOrderId) {
  const itemsUrl = `${base()}/rest/v1/order_items?order_id=eq.${supabaseOrderId}&fulfillment_status=eq.paid&select=id,product_id,presentation_id,quantity,unit,pack_size,output_lot_id`;
  const { data: items } = await axios.get(itemsUrl, { headers: headers() });
  if (!items?.length) return;

  for (const item of items) {
    try {
      const ps = Number(item.pack_size || 0);
      const unit = (item.unit || '').toLowerCase();
      const kgAmount = (unit === 'kg' ? ps : unit === 'g' ? ps / 1000 : 0) * Number(item.quantity);

      if (item.output_lot_id && kgAmount > 0) {
        // Roasted coffee — reverse FIFO lot deduction
        const lotRows = await get('product_lot_assignments', {
          output_lot_id: `eq.${item.output_lot_id}`,
          product_id:    `eq.${item.product_id}`,
          select:        'id,kg_sold'
        });
        if (lotRows[0]) {
          await patch('product_lot_assignments', { id: `eq.${lotRows[0].id}` }, {
            kg_sold: Math.max(0, Number(lotRows[0].kg_sold) - kgAmount)
          });
        }
      } else if (item.presentation_id) {
        const presRows = await get('product_presentations', { id: `eq.${item.presentation_id}`, select: 'stock' });
        if (presRows[0]) {
          await patch('product_presentations', { id: `eq.${item.presentation_id}` }, {
            stock: Number(presRows[0].stock) + Number(item.quantity)
          });
        }
      } else if (item.product_id) {
        const prodRows = await get('products', { id: `eq.${item.product_id}`, select: 'stock' });
        if (prodRows[0]) {
          await patch('products', { id: `eq.${item.product_id}` }, {
            stock: Number(prodRows[0].stock) + Number(item.quantity)
          });
        }
      }
      // Reset fulfillment flag
      await patch('order_items', { id: `eq.${item.id}` }, { fulfillment_status: null, output_lot_id: null });
    } catch (itemErr) {
      console.error('[stock] Error restoring item', item.id, itemErr.message);
    }
  }
}

/**
 * Called when any order is cancelled.
 * – Pre-venta orders: decrements kg_reserved in event_offers
 * – Regular confirmed orders: restores presentation / lot stock
 */
async function restoreStockOnCancel(supabaseOrderId) {
  try {
    const orderRows = await get('orders', { id: `eq.${supabaseOrderId}`, select: 'id,notes,status' });
    const order = orderRows[0];
    if (!order) return;

    // Detect pre-venta from notes prefix
    const preVentaMatch = (order.notes || '').match(/^\[PRE-VENTA:([^\]]*)\]/);
    const sourceEventId  = preVentaMatch?.[1] || null;

    if (sourceEventId) {
      await adjustKgReservedForOrder(supabaseOrderId, sourceEventId, -1);
    } else if (['confirmed', 'preparing', 'shipped', 'delivered'].includes(order.status)) {
      // Regular order already confirmed → restore stock
      await restoreStockItems(supabaseOrderId);
    }
  } catch (err) {
    console.error('[stock] restoreStockOnCancel error:', err.message);
  }
}

async function updateOrderStatus(supabaseId, estado) {
  const up = estado.toUpperCase();

  // ── Restricciones para pre-ventas ────────────────────────────────────────────
  // Permitido siempre:   CANCELADO, CONFIRMADO
  // Bloqueado hasta que el evento culmine: EN_PREPARACION, ENVIADO, ENTREGADO, etc.
  const ESTADOS_LIBRES_PREVENTA = new Set(['CANCELADO', 'CONFIRMADO']);
  if (!ESTADOS_LIBRES_PREVENTA.has(up)) {
    const orderRows = await get('orders', { id: `eq.${supabaseId}`, select: 'notes' });
    const order = orderRows[0];
    if (order) {
      const eventIdFromNotes = (order.notes || '').match(/^\[PRE-VENTA:([^\]]*)\]/)?.[1] || null;
      let sourceEventId = eventIdFromNotes;

      if (!sourceEventId) {
        const itemRows = await get('order_items', { order_id: `eq.${supabaseId}`, select: 'source_event_id', limit: 1 });
        sourceEventId = itemRows.find(i => i.source_event_id)?.source_event_id || null;
      }

      if (sourceEventId) {
        const eventRows = await get('roast_events', { id: `eq.${sourceEventId}`, select: 'status' });
        const eventStatus = eventRows[0]?.status;
        if (eventStatus !== 'completed') {
          const err = new Error('Las pre-ventas no permiten cambios manuales de estado. El estado se podrá actualizar cuando el evento de tostado culmine.');
          err.code = 'PREVENTA_STATUS_LOCKED';
          throw err;
        }
      }
    }
  }

  const status = toStatus(estado);
  const fields = { status };
  const now = new Date().toISOString();
  if (up === 'CONFIRMADO'     || status === 'confirmed') fields.confirmed_at  = now;
  if (up === 'EN_PREPARACION' || status === 'preparing') fields.preparing_at  = now;
  if (up === 'ENVIADO'        || status === 'shipped')   fields.shipped_at    = now;
  if (up === 'ENTREGADO'      || status === 'delivered') fields.delivered_at  = now;
  // NO sincronizar payment_status desde el estado del pedido —
  // el pago se gestiona por separado (updatePaymentStatus / evidencias).
  const rows = await patch('orders', { id: `eq.${supabaseId}` }, fields);

  if (up === 'CONFIRMADO') {
    deductStockOnConfirm(supabaseId).catch(err =>
      console.error('[stock] deductStockOnConfirm failed', supabaseId, err.message)
    );
  }
  if (up === 'CANCELADO') {
    restoreStockOnCancel(supabaseId).catch(err =>
      console.error('[stock] restoreStockOnCancel failed', supabaseId, err.message)
    );
  }

  return rows[0] || null;
}

/**
 * Mirrors fincas /api/checkout/[token]/pay stock-deduction logic.
 * Called exactly once: when an order transitions to CONFIRMADO (paid).
 * Uses fulfillment_status = 'paid' on order_items as idempotency guard.
 */
async function deductStockOnConfirm(supabaseOrderId) {
  // 1. Fetch only items not yet fulfilled (guard against double-call)
  const itemsUrl = `${base()}/rest/v1/order_items?order_id=eq.${supabaseOrderId}&fulfillment_status=neq.paid&select=id,product_id,presentation_id,quantity,unit,pack_size,source_event_id`;
  const { data: items } = await axios.get(itemsUrl, { headers: headers() });
  if (!items?.length) return;

  // 2. Batch-fetch products for green_lot_id
  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const prodUrl = `${base()}/rest/v1/products?id=in.(${productIds.join(',')})&select=id,green_lot_id`;
  const { data: productRows } = await axios.get(prodUrl, { headers: headers() });
  const greenLotByProduct = {};
  for (const p of (productRows || [])) {
    if (p.green_lot_id) greenLotByProduct[p.id] = p.green_lot_id;
  }

  // 3. Batch-fetch presentation grind (grind was moved to product_presentations in 0031)
  const presentationIds = [...new Set(items.map(i => i.presentation_id).filter(Boolean))];
  const grindByPresentation = {};
  if (presentationIds.length) {
    const presUrl = `${base()}/rest/v1/product_presentations?id=in.(${presentationIds.join(',')})&select=id,grind`;
    const { data: presRows } = await axios.get(presUrl, { headers: headers() });
    for (const p of (presRows || [])) grindByPresentation[p.id] = p.grind || [];
  }

  for (const item of items) {
    try {
      // ── Pre-order: kg already reserved via reserve_offer_kg at creation ──
      if (item.source_event_id) {
        await patch('order_items', { id: `eq.${item.id}` }, { fulfillment_status: 'paid' });
        continue;
      }

      const kgPerUnit = item.unit === 'kg' ? Number(item.pack_size || 0) :
                        item.unit === 'g'  ? Number(item.pack_size || 0) / 1000 : 0;
      const kgNeeded  = kgPerUnit * Number(item.quantity);

      // ── Green coffee: decrement green_lots.current_kg ──────────────────
      const presGrind  = item.presentation_id ? (grindByPresentation[item.presentation_id] || []) : [];
      const isGreen    = Array.isArray(presGrind) ? presGrind.includes('green') : presGrind === 'green';
      const greenLotId = greenLotByProduct[item.product_id];

      if (isGreen && greenLotId && kgNeeded > 0) {
        const glRows = await get('green_lots', { id: `eq.${greenLotId}`, select: 'current_kg' });
        if (glRows[0]) {
          await patch('green_lots', { id: `eq.${greenLotId}` }, {
            current_kg: Math.max(0, Number(glRows[0].current_kg) - kgNeeded)
          });
        }
        await patch('order_items', { id: `eq.${item.id}` }, { fulfillment_status: 'paid' });
        continue;
      }

      // ── Roasted coffee: FIFO on product_lot_assignments ────────────────
      if (kgNeeded > 0) {
        const assignUrl = `${base()}/rest/v1/product_lot_assignments?product_id=eq.${item.product_id}&select=id,output_lot_id,kg_assigned,kg_sold&order=created_at.asc`;
        const { data: assignments } = await axios.get(assignUrl, { headers: headers() });
        if (assignments?.length) {
          // Find the oldest lot with remaining capacity (FIFO)
          const fifo = assignments.find(a => Number(a.kg_assigned) - Number(a.kg_sold) > 0);
          if (fifo) {
            await patch('product_lot_assignments', { id: `eq.${fifo.id}` }, {
              kg_sold: Number(fifo.kg_sold) + kgNeeded
            });
            await patch('order_items', { id: `eq.${item.id}` }, {
              output_lot_id: fifo.output_lot_id,
              fulfillment_status: 'paid'
            });
          } else {
            // Coffee product but no available lot — mark paid anyway, log it
            console.warn('[stock] No FIFO lot available for product', item.product_id, `(${kgNeeded} kg needed)`);
            await patch('order_items', { id: `eq.${item.id}` }, { fulfillment_status: 'paid' });
          }
          continue; // coffee product handled
        }
      }

      // ── Regular stock (non-coffee): unit-quantity based ────────────────
      if (item.presentation_id) {
        const presStockRows = await get('product_presentations', {
          id: `eq.${item.presentation_id}`,
          select: 'stock'
        });
        if (presStockRows[0]) {
          await patch('product_presentations', { id: `eq.${item.presentation_id}` }, {
            stock: Math.max(0, Number(presStockRows[0].stock) - Number(item.quantity))
          });
        }
      } else {
        const prodStockRows = await get('products', {
          id: `eq.${item.product_id}`,
          select: 'stock'
        });
        if (prodStockRows[0]) {
          await patch('products', { id: `eq.${item.product_id}` }, {
            stock: Math.max(0, Number(prodStockRows[0].stock) - Number(item.quantity))
          });
        }
      }
      await patch('order_items', { id: `eq.${item.id}` }, { fulfillment_status: 'paid' });

    } catch (itemErr) {
      console.error('[stock] Error processing item', item.id, itemErr.message);
    }
  }
}

async function updateOrderFields(supabaseId, fields) {
  const rows = await patch('orders', { id: `eq.${supabaseId}` }, fields);
  return rows[0] || null;
}

async function recalcPaymentStatus(supabaseId) {
  const orders = await get('orders', { id: `eq.${supabaseId}`, select: 'total_cents,paid_at' });
  const order = orders[0];
  const totalCents = order?.total_cents || 0;
  const payments = await get('order_payments', { order_id: `eq.${supabaseId}`, select: 'amount_cents' });
  const paidCents = payments.reduce((s, p) => s + (p.amount_cents || 0), 0);
  const ps = paidCents === 0 ? 'pending' : paidCents >= totalCents ? 'paid' : 'partial';
  const update = { payment_status: ps };
  if (ps === 'paid' && !order?.paid_at) update.paid_at = new Date().toISOString();
  await patch('orders', { id: `eq.${supabaseId}` }, update);
  return ps;
}

// ─── ORDER PAYMENTS ───────────────────────────────────────────────────────────

async function addOrderPayment(supabaseOrderId, { amountCents, notes, createdBy = 'APP' }) {
  const rows = await post('order_payments', {
    order_id: supabaseOrderId, amount_cents: amountCents,
    notes: notes || null, created_by: createdBy
  });
  await recalcPaymentStatus(supabaseOrderId);
  return rows[0] || null;
}

async function deleteOrderPayment(paymentId, supabaseOrderId) {
  await deleteRow('order_payments', { id: `eq.${paymentId}` });
  if (supabaseOrderId) await recalcPaymentStatus(supabaseOrderId);
  return true;
}

// ─── PAYMENT PROOFS ───────────────────────────────────────────────────────────

async function addPaymentProof(paymentId, { url, source = 'APP', notes }) {
  const rows = await post('order_payment_proofs', {
    payment_id: paymentId, url, source, notes: notes || null
  });
  return rows[0] || null;
}

async function verifyPaymentProof(proofId, { bcpOpCode, amountVerifiedCents, verifiedBy }) {
  const rows = await patch('order_payment_proofs', { id: `eq.${proofId}` }, {
    verified: true, verified_at: new Date().toISOString(),
    verified_by: verifiedBy || 'ADMIN',
    bcp_op_code: bcpOpCode || null,
    amount_verified_cents: amountVerifiedCents || null
  });
  return rows[0] || null;
}

async function deletePaymentProof(proofId) {
  await deleteRow('order_payment_proofs', { id: `eq.${proofId}` });
  return true;
}

// ─── ADDRESSES ────────────────────────────────────────────────────────────────

async function getAddressesByCustomer(customerId) {
  return get('customer_addresses', {
    customer_id: `eq.${customerId}`,
    select: '*,customer_address_courier(*)',
    order: 'is_primary.desc,created_at.asc'
  });
}

async function createAddress(customerId, { alias, isPrimary, addressLine, district, department, reference, notes, courier }) {
  const rows = await post('customer_addresses', {
    customer_id:  customerId,
    alias:        alias || null,
    is_primary:   isPrimary || false,
    address_line: addressLine || null,
    district:     district || null,
    department:   department || null,
    reference:    reference || null,
    notes:        notes || null
  });
  const address = rows[0];
  if (!address) throw new Error('Address creation failed');

  if (courier?.company) {
    const courierRows = await post('customer_address_courier', {
      address_id: address.id,
      company:    courier.company,
      agency:     courier.agency || null
    });
    address.customer_address_courier = courierRows[0] || null;
  } else {
    address.customer_address_courier = null;
  }
  return address;
}

async function updateAddress(addressId, { alias, isPrimary, addressLine, district, department, reference, notes, courier }) {
  const fields = {};
  if (alias !== undefined)        fields.alias        = alias;
  if (isPrimary !== undefined)    fields.is_primary   = isPrimary;
  if (addressLine !== undefined)  fields.address_line = addressLine;
  if (district !== undefined)     fields.district     = district;
  if (department !== undefined)   fields.department   = department;
  if (reference !== undefined)    fields.reference    = reference;
  if (notes !== undefined)        fields.notes        = notes;

  let address = null;
  if (Object.keys(fields).length > 0) {
    const rows = await patch('customer_addresses', { id: `eq.${addressId}` }, fields);
    address = rows[0] || null;
  }

  if (courier !== undefined) {
    if (courier?.company) {
      try {
        const existing = await patch('customer_address_courier', { address_id: `eq.${addressId}` }, { company: courier.company, agency: courier.agency || null });
        if (!existing.length) {
          await post('customer_address_courier', { address_id: addressId, company: courier.company, agency: courier.agency || null });
        }
      } catch {
        await post('customer_address_courier', { address_id: addressId, company: courier.company, agency: courier.agency || null });
      }
    } else {
      await deleteRow('customer_address_courier', { address_id: `eq.${addressId}` });
    }
  }
  return address;
}

async function deleteAddress(addressId) {
  await deleteRow('customer_addresses', { id: `eq.${addressId}` });
  return true;
}

async function updateOrderItem(orderNumber, { presentacionId, codigo, cantidad, grind }) {
  // Look up order by order_number
  const url = `${base()}/rest/v1/orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=id,subtotal_cents,shipping_cents`;
  const { data: orders } = await axios.get(url, { headers: headers() });
  const order = orders[0];
  if (!order) throw new Error(`Pedido no encontrado: ${orderNumber}`);

  // Find the matching order_item
  const itemsUrl = `${base()}/rest/v1/order_items?order_id=eq.${order.id}&select=id,unit_price_cents,quantity,line_total_cents${presentacionId ? `&presentation_id=eq.${presentacionId}` : ''}`;
  const { data: items } = await axios.get(itemsUrl, { headers: headers() });

  let item = items[0];
  if (!item && codigo) {
    // fallback: match by product_name contains codigo
    const allUrl = `${base()}/rest/v1/order_items?order_id=eq.${order.id}&select=id,unit_price_cents,quantity,line_total_cents`;
    const { data: allItems } = await axios.get(allUrl, { headers: headers() });
    item = allItems.find(i => i.id === codigo) || allItems[0];
  }
  if (!item) throw new Error('Item no encontrado en el pedido');

  const newLineTotalCents = item.unit_price_cents * cantidad;
  const fields = { quantity: cantidad, line_total_cents: newLineTotalCents };
  if (grind !== undefined) fields.grind = grind || null;

  await patch('order_items', { id: `eq.${item.id}` }, fields);

  // Recalculate order totals
  const allItemsUrl = `${base()}/rest/v1/order_items?order_id=eq.${order.id}&select=id,line_total_cents`;
  const { data: allItems } = await axios.get(allItemsUrl, { headers: headers() });
  // Replace the updated item's value
  const newSubtotalCents = allItems.reduce((sum, i) =>
    sum + (i.id === item.id ? newLineTotalCents : i.line_total_cents), 0);
  const newTotalCents = newSubtotalCents + (order.shipping_cents || 0);
  await patch('orders', { id: `eq.${order.id}` }, {
    subtotal_cents: newSubtotalCents,
    total_cents: newTotalCents,
  });
  return { subtotal: newSubtotalCents / 100, total: newTotalCents / 100 };
}

async function updateOrderShipping(orderNumber, shippingCents) {
  const shipping = Math.round(shippingCents || 0);
  const url = `${base()}/rest/v1/orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=id,subtotal_cents`;
  const { data: orders } = await axios.get(url, { headers: headers() });
  const order = orders[0];
  if (!order) throw new Error(`Pedido no encontrado: ${orderNumber}`);
  const totalCents = (order.subtotal_cents || 0) + shipping;
  const rows = await patch('orders', { id: `eq.${order.id}` }, { shipping_cents: shipping, total_cents: totalCents });
  return rows[0];
}

async function getAddressesByCustomers(customerIds) {
  if (!customerIds || customerIds.length === 0) return [];
  const ids = customerIds.join(',');
  const url = `${base()}/rest/v1/customer_addresses?customer_id=in.(${ids})&select=*,customer_address_courier(*)&order=is_primary.desc,created_at.asc`;
  const { data } = await axios.get(url, { headers: headers() });
  return data;
}

async function deleteRow(path, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${base()}/rest/v1/${path}?${qs}`;
  const axios = require('axios');
  await axios.delete(url, { headers: headers() });
}

/**
 * Returns total kg available in the FIFO lot pool for a product.
 * Only counts assignments whose roast event is 'completed'.
 * Returns null if no lot assignments exist (product uses manual stock).
 */
/**
 * Guarda el stock inicial manual en products.stock (en kg).
 * product_lot_assignments requiere output_lot_id no nulo (trigger),
 * por lo que usamos el campo stock del producto como almacén del kg manual.
 */
async function updateProductLotKg(productId, kgDisponible) {
  await patch('products', { id: `eq.${productId}` }, { stock: kgDisponible });
}

/**
 * Returns available kg split by source:
 *   roastedKg       — total kg disponible de eventos completados
 *   completedLots   — array de lotes completados: [{ kg, roastedAt, lotCode }]
 *   hasNoLots       — true when no completed roast lots
 *   nextEventKg     — kg_offered in the next planned/in_progress event
 *   nextEventDate   — roasted_at ISO string of that event (null if none)
 *   nextEventStatus — 'planned' | 'in_progress' | null
 *   nextEventLotCode— cached_lot_code of that event (null if none)
 */
async function getProductAvailableKgBreakdown(productId) {
  const [lotsRes, nextEventRes, productRes] = await Promise.all([
    axios.get(
      `${base()}/rest/v1/product_lot_assignments?product_id=eq.${productId}&select=${encodeURIComponent('kg_assigned,kg_sold,output_lot:roast_output_lots(event:roast_events(status,roasted_at,cached_lot_code))')}`,
      { headers: headers() }
    ).catch(() => ({ data: [] })),
    axios.get(
      `${base()}/rest/v1/event_offers?product_id=eq.${productId}&select=${encodeURIComponent('kg_offered,event:roast_events(id,roasted_at,status,cached_lot_code)')}`,
      { headers: headers() }
    ).catch(() => ({ data: [] })),
    axios.get(
      `${base()}/rest/v1/products?id=eq.${productId}&select=green_lot_id`,
      { headers: headers() }
    ).catch(() => ({ data: [] })),
  ]);

  // ── Green coffee: fetch green_lots.current_kg if linked ──────────────
  const greenLotId = (productRes.data?.[0])?.green_lot_id || null;
  let greenKg = null, greenLotCode = null;
  if (greenLotId) {
    const glRes = await axios.get(
      `${base()}/rest/v1/green_lots?id=eq.${greenLotId}&select=current_kg,lot_code`,
      { headers: headers() }
    ).catch(() => ({ data: [] }));
    const gl = glRes.data?.[0];
    greenKg = Math.max(0, Number(gl?.current_kg || 0));
    greenLotCode = gl?.lot_code || null;
  }

  // ── Roasted coffee: always compute from product_lot_assignments ───────
  const lots = lotsRes.data || [];

  // Build per-lot breakdown for completed events
  const completedLots = [];
  let roastedKg = 0;
  for (const a of lots) {
    const ev = Array.isArray(a.output_lot?.event) ? a.output_lot?.event[0] : a.output_lot?.event;
    if (ev?.status !== 'completed') continue;
    const kg = Math.max(0, Number(a.kg_assigned) - Number(a.kg_sold));
    roastedKg += kg;
    completedLots.push({
      kg,
      roastedAt: ev.roasted_at || null,
      lotCode:   ev.cached_lot_code || null,
    });
  }
  // Sort oldest → newest
  completedLots.sort((a, b) => new Date(a.roastedAt || 0) - new Date(b.roastedAt || 0));

  // Find next upcoming event (planned or in_progress), sorted by roasted_at asc
  const upcomingOffers = (nextEventRes.data || [])
    .filter(o => {
      const ev = Array.isArray(o.event) ? o.event[0] : o.event;
      return ev?.status === 'planned' || ev?.status === 'in_progress';
    })
    .sort((a, b) => {
      const dateA = new Date((Array.isArray(a.event) ? a.event[0] : a.event)?.roasted_at || 0);
      const dateB = new Date((Array.isArray(b.event) ? b.event[0] : b.event)?.roasted_at || 0);
      return dateA - dateB;
    });

  let nextEventKg = 0, nextEventDate = null, nextEventStatus = null, nextEventLotCode = null;
  if (upcomingOffers.length > 0) {
    const offer = upcomingOffers[0];
    const ev = Array.isArray(offer.event) ? offer.event[0] : offer.event;
    nextEventKg     = Number(offer.kg_offered) || 0;
    nextEventDate   = ev?.roasted_at || null;
    nextEventStatus = ev?.status || null;
    nextEventLotCode= ev?.cached_lot_code || null;
  }

  const hasNoLots = completedLots.length === 0;
  return {
    roastedKg, completedLots, hasNoLots,
    nextEventKg, nextEventDate, nextEventStatus, nextEventLotCode,
    greenKg,      // null if no green_lot_id linked
    greenLotCode, // null if no green_lot_id linked
    isGreenCoffee: greenLotId !== null,
  };
}

async function getProductAvailableKg(productId) {
  const { roastedKg, hasNoLots } = await getProductAvailableKgBreakdown(productId);
  if (hasNoLots) return null;
  return roastedKg;
}

module.exports = {
  getRawSalesCounts,
  getAdminFarmsByPhone,
  getFarm,
  getProducts,
  getAllProducts,
  getProductsWithPresentations,
  getProductAvailableKg,
  getProductAvailableKgBreakdown,
  updateProductLotKg,
  createProduct,
  updateProduct,
  getProductById,
  getPresentations,
  createPresentation,
  updatePresentation,
  deletePresentation,
  getCustomerByPhone,
  getAllCustomers,
  getCustomerById,
  getCustomersByIds,
  createCustomer,
  updateCustomer,
  createOrder,
  getOrdersByCustomer,
  getAddressesByCustomer,
  getAddressesByCustomers,
  createAddress,
  updateAddress,
  deleteAddress,
  updateOrderItem,
  updateOrderShipping,
  getCustomerPrices,
  upsertCustomerPrices,
  deleteCustomerPrice,
  getOrdersByFarm,
  getOrderByIdOrNumber,
  updateOrderStatus,
  updateOrderFields,
  recalcPaymentStatus,
  addOrderPayment,
  deleteOrderPayment,
  addPaymentProof,
  verifyPaymentProof,
  deletePaymentProof,
  getEventOffers,
  createPreorden,
  restoreStockOnCancel
};

// ─── PRE-VENTAS ───────────────────────────────────────────────────────────────

/**
 * Retorna eventos planned/in_progress de una farm con sus offers que aún
 * tienen capacidad disponible (kg_offered > kg_reserved).
 */
async function getEventOffers(farmId) {
  // Step 1: events + offers (product_id only — avoid fragile triple-nested join)
  const evSelect = 'id,roasted_at,status,cached_lot_code,cached_harvest_year,green_in_kg,roasted_out_kg,weight_loss_pct,event_offers(id,kg_offered,kg_reserved,product_id)';
  const evUrl = `${base()}/rest/v1/roast_events?farm_id=eq.${farmId}&status=in.(planned,in_progress)&select=${encodeURIComponent(evSelect)}&order=roasted_at.asc`;
  const { data: events } = await axios.get(evUrl, { headers: headers() });
  if (!events?.length) return [];

  // Step 2: collect unique product_ids across all offers
  const productIds = [...new Set(
    events.flatMap(ev => (ev.event_offers || []).map(o => o.product_id).filter(Boolean))
  )];

  // Step 3: fetch products + presentations + media images (solo si hay offers con productos)
  const productMap = {};
  if (productIds.length) {
    const pSelect = 'id,name,currency,price_cents,product_presentations(id,pack_size,unit,price_cents,min_order_qty,stock,is_default,is_visible,sort_order,grind)';
    const [productRows, mediaRows] = await Promise.all([
      axios.get(`${base()}/rest/v1/products?id=in.(${productIds.join(',')})&select=${encodeURIComponent(pSelect)}`, { headers: headers() }),
      get('media', {
        owner_id: `in.(${productIds.join(',')})`,
        select:   'presentation_id,url,sort_order',
        order:    'sort_order.asc'
      })
    ]);
    // Build presentation → image_url map (first image per presentation)
    const presImageMap = {};
    for (const m of (mediaRows || [])) {
      if (m.presentation_id && !presImageMap[m.presentation_id]) {
        presImageMap[m.presentation_id] = m.url;
      }
    }
    for (const p of (productRows.data || [])) {
      productMap[p.id] = {
        ...p,
        product_presentations: (p.product_presentations || []).map(pp => ({
          ...pp,
          image_url: presImageMap[pp.id] || null
        }))
      };
    }
  }

  // Calcular kg estimados de salida del tueste
  // Si ya tiene roasted_out_kg (tueste en progreso) lo usa directamente.
  // Si solo tiene green_in_kg lo aplica con weight_loss_pct o merma estándar (18%).
  function estimatedKgOut(ev) {
    if (ev.roasted_out_kg != null) return Number(ev.roasted_out_kg);
    if (ev.green_in_kg != null) {
      const loss = ev.weight_loss_pct != null ? Number(ev.weight_loss_pct) / 100 : 0.18;
      return Math.round(Number(ev.green_in_kg) * (1 - loss) * 100) / 100;
    }
    return null;
  }

  // Step 4: merge y attach product.
  // Se muestran TODOS los eventos planned/in_progress (incluso sin kg disponible)
  // para que la pantalla de pre-ventas los liste; la disponibilidad se indica visualmente.
  return events
    .map(ev => ({
      ...ev,
      green_in_kg:     ev.green_in_kg     != null ? Number(ev.green_in_kg)     : null,
      roasted_out_kg:  ev.roasted_out_kg  != null ? Number(ev.roasted_out_kg)  : null,
      weight_loss_pct: ev.weight_loss_pct != null ? Number(ev.weight_loss_pct) : null,
      estimated_kg_out: estimatedKgOut(ev),
      event_offers: (ev.event_offers || [])
        .map(o => ({ ...o, product: productMap[o.product_id] || null }))
        .filter(o => o.product) // solo excluir offers sin producto
    }));
}

/**
 * Crea una pre-orden: reserva kg en event_offers y crea la order + order_item
 * con source_event_id para trazabilidad.
 */
async function createPreorden({ farmId, offerId, sourceEventId, presentationId, cantidad = 1, cliente }) {
  const qty = Math.max(1, Math.round(Number(cantidad) || 1));

  // 1. Leer la offer + producto desde Supabase (2-step, igual que getEventOffers)
  const offerUrl = `${base()}/rest/v1/event_offers?id=eq.${offerId}&select=id,kg_offered,kg_reserved,product_id`;
  const { data: offerRows } = await axios.get(offerUrl, { headers: headers() });
  const offer = offerRows?.[0];
  if (!offer) throw new Error('Offer no encontrada');

  const remaining = Number(offer.kg_offered) - Number(offer.kg_reserved);
  if (remaining <= 0) throw new Error('Sin capacidad disponible para esta pre-venta');

  // Fetch product + presentations separately
  const pSelect = 'id,name,price_cents,currency,farm_id,product_presentations(id,pack_size,unit,price_cents)';
  const pUrl = `${base()}/rest/v1/products?id=eq.${offer.product_id}&select=${encodeURIComponent(pSelect)}`;
  const { data: productRows } = await axios.get(pUrl, { headers: headers() });
  const product = productRows?.[0];
  if (!product) throw new Error('Producto de la offer no encontrado');

  const presentations = product.product_presentations || [];
  const pres = presentationId
    ? presentations.find(p => p.id === presentationId)
    : presentations.find(p => p.is_default) || presentations[0];
  if (!pres) throw new Error('Presentación no encontrada');

  const kgPerUnit  = pres.unit === 'kg' ? Number(pres.pack_size) : Number(pres.pack_size) / 1000;
  if (kgPerUnit <= 0) throw new Error('Presentación inválida (kg por unidad = 0)');

  const kgToReserve = kgPerUnit * qty;
  if (kgToReserve > remaining) {
    throw new Error(`Solo quedan ${remaining.toFixed(2)} kg disponibles (pediste ${kgToReserve.toFixed(2)} kg)`);
  }

  const unitPriceCents = pres.price_cents || product.price_cents;
  const lineTotalCents = unitPriceCents * qty;
  const currency       = product.currency || 'PEN';

  // 2. Reservar kg totales atómicamente vía RPC
  await axios.post(
    `${base()}/rest/v1/rpc/reserve_offer_kg`,
    { p_offer_id: offerId, p_kg: kgToReserve },
    { headers: headers() }
  );

  // 3. Crear orden en Supabase
  const orderRows = await post('orders', {
    customer_id:    cliente.id    || null,
    customer_email: cliente.email || `guest-${Date.now()}@fincas.app`,
    customer_name:  cliente.nombre,
    customer_phone: cliente.whatsapp,
    subtotal_cents: lineTotalCents,
    shipping_cents: 0,
    total_cents:    lineTotalCents,
    currency,
    status:         'pending',
    payment_method: 'pending',
    notes:          `Pre-orden de tueste programado`
  });
  const order = orderRows[0];
  if (!order) throw new Error('No se pudo crear la orden');

  // 4. Crear order_item con source_event_id y cantidad correcta
  await post('order_items', [{
    order_id:           order.id,
    farm_id:            farmId,
    product_id:         product.id,
    presentation_id:    pres.id,
    product_name:       product.name,
    unit:               pres.unit,
    pack_size:          pres.pack_size,
    quantity:           qty,
    unit_price_cents:   unitPriceCents,
    line_total_cents:   lineTotalCents,
    commission_rate:    0.10,
    commission_cents:   Math.round(lineTotalCents * 0.10),
    payout_cents:       Math.round(lineTotalCents * 0.90),
    source_event_id:    sourceEventId,
    fulfillment_status: 'pending'
  }]);

  return { orderId: order.id, orderNumber: order.order_number };
}
