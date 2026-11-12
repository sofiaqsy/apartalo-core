/**
 * WHO CREATED EACH PEDIDO (General Manager, 11 Nov 2026, on a pedido of Stein Nuñure: "give more detail from which
 * canal was created?", then "Yes, add it"). orders.canal only says manual or web; fincas 0074 adds order_origins:
 * for each new pedido, where it came from (app = Nuevo Pedido in the Apartalo app, whatsapp = the WhatsApp bot) and,
 * from the app, the person signed in. The server records and reads it with the service role. A failure here never
 * stops a pedido: it is only logged.
 */

function extractBearer(req) {
  const header = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * @param {object} deps
 * @param {(fn:string, body:object)=>Promise<any>} deps.rpc   a fincas function with the service role
 * @param {(token:string)=>Promise<object>} [deps.verifyToken] firebaseService.verifyIdToken
 */
function createOrderOrigin({ rpc, verifyToken = null, log = console } = {}) {
  /** The person signed in on the request ({} when there is no valid login). Only a verified email is kept. */
  async function persona(req) {
    const token = extractBearer(req);
    if (!token || !verifyToken) return {};
    try {
      const id = await verifyToken(token);
      return { uid: id.uid || null, email: id.emailVerified ? id.email || null : null, nombre: id.name || null };
    } catch (_) {
      return {};
    }
  }

  async function registrar(orderId, origen, quien = {}) {
    if (!orderId) return false;
    try {
      await rpc('order_origin_record', {
        p_order_id: orderId, p_origen: origen, p_uid: quien.uid || null, p_email: quien.email || null, p_nombre: quien.nombre || null,
      });
      return true;
    } catch (err) {
      log.error(`Origen del pedido ${orderId} no guardado: ${err.message}`);
      return false;
    }
  }

  /** {origen, nombre, email, fecha} or null (pedidos before 11 Nov 2026 have none). */
  async function de(orderId) {
    if (!orderId) return null;
    try {
      const r = await rpc('order_origin_of', { p_order_id: orderId });
      return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    } catch (_) {
      return null;
    }
  }

  return { persona, registrar, de };
}

module.exports = { createOrderOrigin };
