/**
 * PARTNER PRODUCTS ROUTER: protected product services for outside apps (any authorized client).
 * Mounted at /api/v1/farms. Generic: nothing here names a specific app.
 *
 * Every call:
 *   1. needs `Authorization: Bearer <Firebase ID token>` of project apartalo-10146 (401 otherwise);
 *   2. the person must be an active owner or staff member of :farmId, read from the same session as
 *      /api/auth/session (403 otherwise). It works whatever AUTH_MODE is.
 * Writes reuse the same product functions and rows as Apartalo (no copies).
 * POST needs an `Idempotency-Key` header: a retry with the same key returns the first answer and changes nothing.
 * Each person has a per-minute limit (429 when passed).
 * Logs never contain tokens, emails, phones or bodies.
 * The routes the Apartalo app uses today (/api/productos/...) are not changed.
 */
const express = require('express');
const { extractBearer } = require('../core/middleware/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['draft', 'active', 'archived'];
const MEMBER_ROLES = ['owner', 'staff'];

class InputError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; }
}

const text = (v, field, { max = 200, required = false } = {}) => {
  if (v === undefined || v === null) {
    if (required) throw new InputError(400, `Missing field: ${field}`, field);
    return undefined;
  }
  if (typeof v !== 'string') throw new InputError(400, `${field} must be text`, field);
  const s = v.trim();
  if (required && !s) throw new InputError(400, `Missing field: ${field}`, field);
  if (s.length > max) throw new InputError(400, `${field} is too long (max ${max})`, field);
  return s;
};
const money = (v, field) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new InputError(400, `${field} must be a price in soles (0 or more)`, field);
  return Math.round(n * 100);
};
const count = (v, field) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e6) throw new InputError(400, `${field} must be a whole number (0 or more)`, field);
  return n;
};
const positive = (v, field) => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e5) throw new InputError(400, `${field} must be more than 0`, field);
  return n;
};
const flag = (v, field) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new InputError(400, `${field} must be true or false`, field);
  return v;
};

const toProduct = p => ({
  id: p.id, name: p.name, description: p.description || '', status: p.status, currency: p.currency || 'PEN',
  imageUrl: p.image_url || null,
  presentations: (p.presentations || []).map(toPresentation),
});
const toPresentation = pp => ({
  id: pp.id, packSize: pp.pack_size, unit: pp.unit, price: (pp.price_cents || 0) / 100,
  stock: pp.stock || 0, visible: pp.is_visible !== false, isDefault: !!pp.is_default,
  photos: (pp.fotos || []).map(f => ({ id: f.id, url: f.url })),
});

/** Small in-memory memory of answers per person and key (lost on restart; enough for phone retries). */
function createIdempotency({ ttlMs = 24 * 3600 * 1000, max = 2000, now = () => Date.now() } = {}) {
  const seen = new Map();
  return {
    get(k) {
      const e = seen.get(k);
      if (!e) return null;
      if (now() - e.at > ttlMs) { seen.delete(k); return null; }
      return e;
    },
    set(k, status, body) {
      if (seen.size >= max) seen.delete(seen.keys().next().value);
      seen.set(k, { status, body, at: now() });
    },
  };
}

function createRateLimit({ perMinute = 60, now = () => Date.now() } = {}) {
  const hits = new Map();
  return k => {
    const t = now(), e = hits.get(k);
    if (!e || t - e.start >= 60000) { hits.set(k, { start: t, n: 1 }); return true; }
    e.n += 1;
    return e.n <= perMinute;
  };
}

function createPartnerProductsRouter({
  verifyToken, resolveSession, products, photos,
  idempotency = createIdempotency(), allow = createRateLimit(), log = console,
} = {}) {
  const router = express.Router();

  async function authenticate(req, res, next) {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    try { req.identity = await verifyToken(token); } catch (e) { return res.status(401).json({ error: 'Sign-in not valid' }); }
    if (!req.identity || !req.identity.uid) return res.status(401).json({ error: 'Sign-in not valid' });
    if (!allow(req.identity.uid)) return res.status(429).json({ error: 'Too many requests, try again in a minute' });
    next();
  }

  async function member(req, res, next) {
    const { farmId } = req.params;
    if (!UUID.test(farmId)) return res.status(404).json({ error: 'Business not found' });
    try {
      const s = await resolveSession(req.identity);
      const b = s && s.status === 'active' && (s.businesses || []).find(x => x.farmId === farmId);
      if (!b || !MEMBER_ROLES.includes(b.role)) return res.status(403).json({ error: 'You are not a member of this business' });
      req.member = b;
      next();
    } catch (e) {
      log.error('[partner-products] session check failed');
      res.status(503).json({ error: 'Could not check access, try again' });
    }
  }

  async function ownProduct(req, res, next) {
    const { farmId, productId } = req.params;
    if (!UUID.test(productId)) return res.status(404).json({ error: 'Product not found' });
    const p = await products.getById(productId);
    if (!p || p.farm_id !== farmId) return res.status(404).json({ error: 'Product not found' });
    req.product = p;
    next();
  }

  async function ownPresentation(req, res, next) {
    const { productId, presentationId } = req.params;
    if (!UUID.test(presentationId)) return res.status(404).json({ error: 'Presentation not found' });
    const pp = await products.getPresentation(presentationId);
    if (!pp || pp.product_id !== productId) return res.status(404).json({ error: 'Presentation not found' });
    req.presentation = pp;
    next();
  }

  /** POST only: the same person and key get the first answer again; nothing is written twice. */
  function once(handler) {
    return async (req, res) => {
      const key = String(req.get('Idempotency-Key') || '').trim();
      if (key.length < 8 || key.length > 100) return res.status(400).json({ error: 'Send an Idempotency-Key header (8 to 100 characters)' });
      const k = `${req.identity.uid}:${req.method}:${req.originalUrl.split('?')[0]}:${key}`;
      const prev = idempotency.get(k);
      if (prev) return res.status(prev.status).json(prev.body);
      const send = (status, body) => { if (status < 500) idempotency.set(k, status, body); res.status(status).json(body); };
      return handler(req, res, send);
    };
  }

  const wrap = fn => async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
      if (e instanceof InputError) return res.status(e.status).json({ error: e.message, field: e.field });
      if (e && Number.isInteger(e.status) && e.status < 500) return res.status(e.status).json({ error: e.message });
      log.error('[partner-products]', req.method, req.route && req.route.path, (e && e.message) || 'error');
      res.status(500).json({ error: 'Internal error' });
    }
  };

  const base = [authenticate, member];

  // List all products of the business (drafts and archived included), 20 at a time.
  router.get('/:farmId/products', ...base, wrap(async (req, res) => {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const all = await products.list(req.params.farmId);
    const items = all.slice(offset, offset + limit).map(toProduct);
    res.json({ items, total: all.length, hasMore: offset + limit < all.length });
  }));

  router.get('/:farmId/products/:productId', ...base, wrap(ownProduct), wrap(async (req, res) => {
    const all = await products.list(req.params.farmId);
    const p = all.find(x => x.id === req.params.productId);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json(toProduct(p));
  }));

  // Create a product (starts as draft unless status says otherwise).
  router.post('/:farmId/products', ...base, wrap(once(async (req, res, send) => {
    const b = req.body || {};
    const name = text(b.name, 'name', { required: true, max: 120 });
    const description = text(b.description, 'description', { max: 2000 });
    const status = b.status === undefined ? 'draft' : b.status;
    if (!STATUSES.includes(status)) throw new InputError(400, `status must be one of ${STATUSES.join(', ')}`, 'status');
    const created = await products.create(req.params.farmId, { name, description, status });
    if (!created) return send(500, { error: 'Could not create the product' });
    send(201, toProduct({ ...created, presentations: [] }));
  })));

  // Change name, description or status (archived = hidden; nothing is deleted).
  router.patch('/:farmId/products/:productId', ...base, wrap(ownProduct), wrap(async (req, res) => {
    const b = req.body || {};
    const fields = {};
    const name = text(b.name, 'name', { required: b.name !== undefined, max: 120 });
    const description = text(b.description, 'description', { max: 2000 });
    if (name !== undefined) fields.name = name;
    if (description !== undefined) fields.description = description;
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw new InputError(400, `status must be one of ${STATUSES.join(', ')}`, 'status');
      fields.status = b.status;
    }
    if (!Object.keys(fields).length) throw new InputError(400, 'Nothing to change');
    const updated = await products.update(req.params.productId, fields);
    res.json(toProduct({ ...req.product, ...(updated || fields), presentations: undefined }));
  }));

  // A presentation is a size with its price and stock (for example 250 g at S/ 25).
  router.post('/:farmId/products/:productId/presentations', ...base, wrap(ownProduct), wrap(once(async (req, res, send) => {
    const b = req.body || {};
    const packSize = positive(b.packSize, 'packSize');
    const unit = text(b.unit, 'unit', { required: true, max: 20 });
    const priceCents = money(b.price, 'price');
    if (packSize === undefined) throw new InputError(400, 'Missing field: packSize', 'packSize');
    if (priceCents === undefined) throw new InputError(400, 'Missing field: price', 'price');
    const created = await products.createPresentation(req.params.productId, {
      packSize, unit, priceCents, stock: count(b.stock, 'stock') || 0, isVisible: flag(b.visible, 'visible') !== false,
    });
    if (!created) return send(500, { error: 'Could not create the presentation' });
    send(201, toPresentation(created));
  })));

  router.patch('/:farmId/products/:productId/presentations/:presentationId', ...base, wrap(ownProduct), wrap(ownPresentation), wrap(async (req, res) => {
    const b = req.body || {};
    const fields = {};
    const set = (k, v) => { if (v !== undefined) fields[k] = v; };
    set('pack_size', positive(b.packSize, 'packSize'));
    set('unit', text(b.unit, 'unit', { required: b.unit !== undefined, max: 20 }));
    set('price_cents', money(b.price, 'price'));
    set('stock', count(b.stock, 'stock'));
    set('is_visible', flag(b.visible, 'visible'));
    if (!Object.keys(fields).length) throw new InputError(400, 'Nothing to change');
    const updated = await products.updatePresentation(req.params.presentationId, fields);
    res.json(toPresentation({ ...req.presentation, ...(updated || fields) }));
  }));

  // Photos: 1) ask a signed upload URL, 2) PUT the bytes there, 3) register the path. Up to 3 per presentation.
  router.post('/:farmId/products/:productId/presentations/:presentationId/photos/sign', ...base, wrap(ownProduct), wrap(ownPresentation), wrap(async (req, res) => {
    res.json(await photos.prepareUpload(req.params.productId, req.params.presentationId, (req.body || {}).mimeType));
  }));

  router.post('/:farmId/products/:productId/presentations/:presentationId/photos', ...base, wrap(ownProduct), wrap(ownPresentation), wrap(once(async (req, res, send) => {
    const b = req.body || {};
    const f = await photos.register(req.params.productId, req.params.presentationId, b.path, b.mimeType);
    send(201, { id: f.id, url: f.url });
  })));

  return router;
}

module.exports = { createPartnerProductsRouter, createIdempotency, createRateLimit };
