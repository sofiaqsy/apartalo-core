/**
 * AUTH middleware (dormant by default).
 *
 * AUTH_MODE:
 *   off      (default) does nothing; behaviour is exactly as before.
 *   observe  never blocks. Logs one line per request so we can see which clients
 *            still call the API without credentials before enforcing anything.
 *   enforce  requires a valid Firebase ID token (Bearer) and sets req.auth.
 *
 * SAFETY: `enforce` must never be active without a membership check, because any
 * person could sign in with Google or Apple and would then pass. So `enforce` is
 * only honoured when the caller declares `canEnforce: true` (i.e. a membership
 * provider is wired). Otherwise it is downgraded to `observe` with a loud error.
 * An unknown mode value also falls back to `observe` (never blocks, but is visible).
 *
 * Logs never contain tokens, emails, phone numbers, bodies or query strings.
 */

const MODES = ['off', 'observe', 'enforce'];

/** Routes (relative to the mount point, usually /api) that stay public by design. */
const DEFAULT_EXEMPT = ['/track'];

function resolveMode(raw, { canEnforce = false } = {}) {
  const value = String(raw == null || raw === '' ? 'off' : raw).trim().toLowerCase();
  if (!MODES.includes(value)) {
    return { mode: 'observe', warning: `AUTH_MODE="${String(raw).slice(0, 20)}" no es válido; se usa "observe"` };
  }
  if (value === 'enforce' && !canEnforce) {
    return {
      mode: 'observe',
      warning: 'AUTH_MODE=enforce requiere comprobar membresía por negocio, que aún no está conectada; se usa "observe"',
    };
  }
  return { mode: value };
}

/** Replaces ids with placeholders so the route can be logged without identifiers. */
function routePattern(path) {
  return String(path || '/')
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    .replace(/\bORD-[0-9A-Za-z-]+/g, ':order')
    .replace(/\bPED-[0-9A-Za-z-]+/g, ':order')
    .replace(/\bBIZ-[0-9A-Za-z-]+/g, ':biz')
    .replace(/\/\d{4,}(?=\/|$)/g, '/:num')
    .slice(0, 120);
}

function extractBearer(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

function clientLabel(req) {
  const raw = typeof req.get === 'function' ? req.get('x-client') : req.headers && req.headers['x-client'];
  if (!raw) return 'legacy';
  return String(raw).replace(/[^A-Za-z0-9._/\-]/g, '').slice(0, 40) || 'legacy';
}

function uaFamily(req) {
  const raw = (typeof req.get === 'function' ? req.get('user-agent') : req.headers && req.headers['user-agent']) || '';
  return String(raw).split(/[\s/]/)[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20) || 'none';
}

/**
 * @param {object} opts
 * @param {string} [opts.mode]            raw AUTH_MODE value
 * @param {boolean} [opts.canEnforce]     true only when membership checks are wired
 * @param {(token:string)=>Promise<object>} [opts.verifyToken]  e.g. firebaseService.verifyIdToken
 * @param {string[]} [opts.exempt]        public path prefixes
 * @param {object} [opts.log]             logger with log/error (default console)
 */
function createAuth({ mode, canEnforce = false, verifyToken, exempt = DEFAULT_EXEMPT, log = console } = {}) {
  const resolved = resolveMode(mode, { canEnforce });
  if (resolved.warning) log.error(`[AUTH] ${resolved.warning}`);
  const active = resolved.mode;

  const middleware = async function authMiddleware(req, res, next) {
    if (active === 'off') return next();

    const path = req.path || '/';
    if (exempt.some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
      req.auth = { exempt: true };
      return next();
    }

    const token = extractBearer(req);

    if (active === 'observe') {
      log.log(`[AUTH-OBSERVE] ${req.method} ${routePattern(path)} client=${clientLabel(req)} ua=${uaFamily(req)} token=${token ? 'yes' : 'no'}`);
      return next();
    }

    // enforce
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    try {
      const identity = await verifyToken(token);
      req.auth = { uid: identity.uid, provider: identity.provider || null };
      return next();
    } catch (err) {
      if (err && err.code === 'auth/not-initialized') {
        log.error('[AUTH] Firebase no está inicializado; no se puede verificar el token');
        return res.status(503).json({ error: 'Autenticación no disponible' });
      }
      return res.status(401).json({ error: 'Token inválido o vencido' });
    }
  };

  middleware.mode = active;
  return middleware;
}

module.exports = { createAuth, resolveMode, routePattern, extractBearer, MODES, DEFAULT_EXEMPT };
