/**
 * ACCESS middleware: "is this user a member of this business, with enough role?"
 *
 * It is dormant: nothing in the app mounts it yet, because the real role lookup
 * (Firebase uid -> profile -> farm_members) depends on a pending schema decision.
 * The lookup is injected (`getRole`), so the logic is complete and testable now.
 *
 * Authorization comes ONLY from membership. Email, phone and display name from the
 * identity provider are never consulted.
 *
 * Roles are ranked roaster < staff < owner (each role includes the permissions of
 * the lower ones). This reflects the proposed role matrix (decision D5) and is the
 * single place to change if that matrix changes. Unknown roles rank 0: no access.
 */

const ROLE_RANK = Object.freeze({ roaster: 1, staff: 2, owner: 3 });

const MODES = ['off', 'observe', 'enforce'];

function roleRank(role) {
  return ROLE_RANK[String(role || '').toLowerCase()] || 0;
}

/**
 * @param {object} opts
 * @param {string} [opts.mode]  'off' | 'observe' | 'enforce'
 * @param {(businessId:string)=>object|null} opts.getNegocio   e.g. negociosService.getById
 * @param {(uid:string, farmId:string)=>Promise<string|null>} opts.getRole  membership lookup
 * @param {object} [opts.log]
 * @returns {(minRole:string)=>Function} factory of express middlewares
 */
function createAccess({ mode = 'off', getNegocio, getRole, log = console } = {}) {
  const active = MODES.includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'observe';
  if (active !== String(mode).toLowerCase()) {
    log.error(`[ACCESS] modo "${String(mode).slice(0, 20)}" no es válido; se usa "observe"`);
  }

  return function requireBusinessAccess(minRole = 'staff') {
    const needed = roleRank(minRole);

    return async function accessMiddleware(req, res, next) {
      if (active === 'off') return next();

      const businessId = req.params && req.params.businessId;
      if (!businessId) return next();                     // route without a business in the path

      let decision = null;                                // {status, error, reason}
      try {
        const negocio = getNegocio(businessId);
        if (!negocio) {
          decision = { status: 404, error: 'Negocio no encontrado', reason: 'unknown-business' };
        } else if (!req.auth || !req.auth.uid) {
          decision = { status: 401, error: 'No autenticado', reason: 'unauthenticated' };
        } else {
          const role = await getRole(req.auth.uid, negocio.farmId);
          if (roleRank(role) < needed) {
            decision = { status: 403, error: 'Sin acceso a este negocio', reason: role ? 'role-too-low' : 'not-a-member' };
          }
        }
      } catch (err) {
        log.error(`[ACCESS] error al resolver membresía: ${err && err.message}`);
        if (active === 'enforce') return res.status(503).json({ error: 'No se pudo verificar el acceso' });
        return next();                                    // observe: never block on our own failure
      }

      if (!decision) return next();

      if (active === 'observe') {
        log.log(`[ACCESS-OBSERVE] would-deny reason=${decision.reason} min=${minRole} ${req.method} ${String(req.baseUrl || '')}${String(req.route && req.route.path || '').slice(0, 80)}`);
        return next();
      }
      return res.status(decision.status).json({ error: decision.error });
    };
  };
}

module.exports = { createAccess, roleRank, ROLE_RANK, MODES };
