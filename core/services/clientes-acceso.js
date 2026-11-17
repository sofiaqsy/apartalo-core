/**
 * ACCESS TO THE SERVER ROUTES. First for Clientes (only the business's own, and a seller only his), then for every
 * route that changes data or shows private data (17 Nov 2026, phase 1). CLIENTES: ONLY THE BUSINESS'S OWN, AND A SELLER ONLY HIS (General Manager, 17 Nov 2026: "I have a new account and
 * there I can see the clients of Finca Rosal ... each seller should have his own Clientes"). Before, the Clientes routes
 * listed every customer of Apartalo to anyone. Now every route asks the database, with the person's own login
 * (Firebase token, as the Administración routes do), whether the person is a member of the business and which clients
 * they may see (fincas 0082): owners and the Comercial area see all; anyone else only the clients they created.
 */

function extractBearer(req) {
  const header = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} deps
 * @param {(businessId:string)=>object|null} deps.getNegocio  the business (with farmId)
 */
function createClientesAcceso({
  getNegocio,
  fetchImpl = (...a) => fetch(...a),
  supabaseUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, ''),
  publishableKey = () => process.env.SUPABASE_PUBLISHABLE_KEY || '',
} = {}) {
  /** A fincas function with the person's own login. */
  async function rpc(token, fn, body) {
    const res = await fetchImpl(`${supabaseUrl()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: publishableKey(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data };
  }

  /** Every Clientes route: a person signed in who is a member of the business. Sets req.clientes. */
  async function acceso(req, res, next) {
    const negocio = getNegocio(req.params.businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (!negocio.farmId) return res.status(403).json({ error: 'Sin acceso a este negocio' });
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    try {
      const r = await rpc(token, 'farm_customer_access', { p_business_id: negocio.farmId });
      if (!r.ok) return res.status(r.status === 401 ? 401 : 503).json({ error: 'No se pudo verificar el acceso' });
      if (!r.data || r.data.miembro !== true) return res.status(403).json({ error: 'Sin acceso a este negocio' });
      req.clientes = { token, farmId: negocio.farmId, veTodos: r.data.ve_todos === true, rpc: (fn, body) => rpc(token, fn, body) };
      return next();
    } catch (_) {
      return res.status(503).json({ error: 'No se pudo verificar el acceso' });
    }
  }

  /** A route with :clienteId: only a client the person may see. Guests (no account) only for who sees all. */
  async function visible(req, res, next, clienteId) {
    const c = req.clientes;
    if (!c) return res.status(401).json({ error: 'No autenticado' });
    if (String(clienteId).startsWith('guest:')) {
      return c.veTodos ? next() : res.status(404).json({ error: 'Cliente no encontrado' });
    }
    if (!UUID.test(String(clienteId))) return next(); // the route says the id is not valid
    try {
      const r = await c.rpc('farm_customer_visible', { p_business_id: c.farmId, p_customer_id: clienteId });
      if (!r.ok) return res.status(503).json({ error: 'No se pudo verificar el acceso' });
      return r.data === true ? next() : res.status(404).json({ error: 'Cliente no encontrado' });
    } catch (_) {
      return res.status(503).json({ error: 'No se pudo verificar el acceso' });
    }
  }

  /** The same membership check for a route whose business is not in the path (in the body or the query). */
  function accesoPor(getBusinessId) {
    return (req, res, next) => {
      const id = getBusinessId(req);
      if (!id) return res.status(400).json({ error: 'Falta el negocio' });
      req.params = { ...(req.params || {}), businessId: String(id) };
      return acceso(req, res, next);
    };
  }

  /** A person signed in (a valid Firebase login). Sets req.persona {token, perfiles} with the profiles that are theirs. */
  async function login(req, res, next) {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    try {
      const r = await rpc(token, 'me_profile_ids', {});
      if (!r.ok) return res.status(r.status === 401 || r.status === 403 ? 401 : 503).json({ error: 'No autenticado' });
      const perfiles = Array.isArray(r.data) ? r.data.map(String) : [];
      if (!perfiles.length) return res.status(401).json({ error: 'No autenticado' });
      req.persona = { token, perfiles, rpc: (fn, body) => rpc(token, fn, body) };
      return next();
    } catch (_) {
      return res.status(503).json({ error: 'No se pudo verificar el acceso' });
    }
  }

  return { acceso, visible, rpc, accesoPor, login };
}

module.exports = { createClientesAcceso };
