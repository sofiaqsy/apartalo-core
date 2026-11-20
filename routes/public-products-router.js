/**
 * PUBLIC PRODUCTS ROUTER: products and prices of an approved business, for anyone (no login).
 * Mounted at /api/public/farms. Generic: nothing here names a specific app; each client decides which
 * businesses it shows.
 *
 *   GET /:farmId/products?offset=0&limit=20 -> { items, total, hasMore }
 *
 * Only approved farms (farms.status = 'approved'), only active products, only visible presentations.
 * No customer, order, cost, supplier, lot, sales, member or phone data.
 * Answers are cached 60 seconds (server and Cache-Control). 120 calls per minute per IP.
 */
const express = require('express');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT = 300;

const short = s => {
  const t = String(s || '').trim();
  return t.length > SHORT ? t.slice(0, SHORT - 1).trimEnd() + '…' : t;
};

function toPublic(p) {
  const presentations = (p.presentations || [])
    .filter(pp => pp.is_visible !== false)
    .map(pp => ({
      id: pp.id, packSize: pp.pack_size, unit: pp.unit, price: (pp.price_cents || 0) / 100,
      available: (pp.stock || 0) > 0, photoUrl: pp.image_url || null,
    }));
  if (!presentations.length) return null; // nothing to sell or no price: not shown
  return {
    id: p.id, name: p.name, description: short(p.description), currency: p.currency || 'PEN',
    photoUrl: p.image_url || presentations.find(x => x.photoUrl)?.photoUrl || null,
    available: presentations.some(x => x.available),
    presentations,
  };
}

/** The real client IP on Heroku is the last X-Forwarded-For entry (the router appends it). */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createIpLimit({ perMinute = 120, now = () => Date.now(), max = 5000 } = {}) {
  const hits = new Map();
  return ip => {
    const t = now(), e = hits.get(ip);
    if (!e || t - e.start >= 60000) {
      if (hits.size >= max) hits.delete(hits.keys().next().value);
      hits.set(ip, { start: t, n: 1 });
      return true;
    }
    e.n += 1;
    return e.n <= perMinute;
  };
}

function createPublicProductsRouter({ getApprovedFarm, listProducts, allow = createIpLimit(), ttlMs = 60000, now = () => Date.now(), log = console } = {}) {
  const router = express.Router();
  const cache = new Map(); // farmId -> { at, items } ; items null = not an approved farm

  async function load(farmId) {
    const c = cache.get(farmId);
    if (c && now() - c.at < ttlMs) return c.items;
    const farm = await getApprovedFarm(farmId);
    const items = farm ? (await listProducts(farmId)).filter(p => p.status === 'active').map(toPublic).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name)) : null;
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    cache.set(farmId, { at: now(), items });
    return items;
  }

  router.get('/:farmId/products', async (req, res) => {
    if (!allow(clientIp(req))) return res.status(429).json({ error: 'Too many requests, try again in a minute' });
    const { farmId } = req.params;
    if (!UUID.test(farmId)) return res.status(404).json({ error: 'Business not found' });
    try {
      const all = await load(farmId);
      if (!all) return res.status(404).json({ error: 'Business not found' });
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ items: all.slice(offset, offset + limit), total: all.length, hasMore: offset + limit < all.length });
    } catch (e) {
      log.error('[public-products] load failed');
      res.status(503).json({ error: 'Products are not available right now, try again' });
    }
  });

  return router;
}

module.exports = { createPublicProductsRouter, createIpLimit, toPublic, clientIp };
