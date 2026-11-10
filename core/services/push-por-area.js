/**
 * PUSH POR ÁREA (General Manager, 10 Nov 2026): every minute, for each business linked to fincas, the database gives the
 * new events not sent yet (fincas 0070, push_events_claim_v2, service role only; 12 hours back, so what happens while
 * the server sleeps is sent when it wakes), each with the phones of the people who have its area marked:
 *   Nuevo pedido   -> Comercialización
 *   Pago pendiente -> Finanzas (gasto to pay, adelanto to approve, Solicitar pago of a compra)
 * The database marks each event sent before it comes back, so a phone never gets the same event twice. A phone that
 * Firebase says is no longer valid is removed (push_unregister_device).
 *
 * Server settings: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (already set), and Firebase (FCM) initialized.
 */
const INVALIDOS = new Set(['messaging/invalid-registration-token', 'messaging/registration-token-not-registered']);

/**
 * @param {object} deps
 * @param {()=>object[]} deps.negocios      the businesses (each with farmId when it is linked to fincas)
 * @param {()=>object|null} deps.messaging  firebase-admin messaging, or null while Firebase is not ready
 * @param {Function} [deps.fetchImpl]
 * @param {()=>string} [deps.supabaseUrl]
 * @param {()=>string} [deps.serviceKey]
 */
function createPushPorArea({
  negocios,
  messaging,
  fetchImpl = (...a) => fetch(...a),
  supabaseUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, ''),
  serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  log = console,
} = {}) {
  async function rpc(fn, body) {
    const res = await fetchImpl(`${supabaseUrl()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${fn} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /** One event to its phones. Returns how many phones got it. */
  async function enviar(m, evento) {
    const tokens = Array.isArray(evento.tokens) ? evento.tokens : [];
    if (!tokens.length) return 0;
    const data = Object.fromEntries(Object.entries(evento.datos || {}).map(([k, v]) => [k, String(v ?? '')]));
    const r = await m.sendEachForMulticast({
      notification: { title: evento.titulo, body: evento.texto || '' },
      data: { ...data, area: String(evento.area || '') },
      apns: { payload: { aps: { sound: 'default' } } },
      android: { priority: 'high', notification: { sound: 'default' } },
      tokens,
    });
    await Promise.all((r.responses || []).map((x, i) =>
      !x.success && x.error && INVALIDOS.has(x.error.code)
        ? rpc('push_unregister_device', { p_token: tokens[i] }).catch(() => null)
        : null));
    return r.successCount || 0;
  }

  /** One round for every business linked to fincas. */
  async function revisar() {
    const m = messaging();
    if (!m || !supabaseUrl() || !serviceKey()) return { eventos: 0, enviados: 0 };
    let eventos = 0;
    let enviados = 0;
    for (const n of negocios().filter(x => x && x.farmId)) {
      try {
        const lista = await rpc('push_events_claim_v2', { p_business_id: n.farmId });
        for (const e of Array.isArray(lista) ? lista : []) {
          eventos++;
          try {
            enviados += await enviar(m, e);
          } catch (err) {
            log.error(`Push ${e.clave} no enviado: ${err.message}`);
          }
        }
      } catch (err) {
        log.error(`Push por área (${n.id}): ${err.message}`);
      }
    }
    if (eventos) log.log(`📤 Push por área: ${eventos} evento(s), ${enviados} teléfono(s)`);
    return { eventos, enviados };
  }

  let timer = null;
  let ocupado = false;
  return {
    revisar,
    iniciar(cadaMs = 60000) {
      if (timer) return;
      timer = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try { await revisar(); } finally { ocupado = false; }
      }, cadaMs);
      if (timer.unref) timer.unref();
    },
    detener() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createPushPorArea };
