/**
 * DELIVERY SERVICE
 *
 * When an order is created in a business with `configExtra.deliveryBizId`,
 * this service:
 *   1. Registers the order as a delivery in the delivery business spreadsheet
 *   2. Broadcasts a WhatsApp message to all couriers (clients of the delivery business)
 *
 * Configuration in the origin business configExtra:
 *   { "deliveryBizId": "BIZ-005" }
 */

const SheetsService = require('./sheets-service');
const WhatsAppService = require('./whatsapp-service');

/**
 * Get current date/time in Peru timezone (UTC-5)
 */
function getPeruDateTime() {
  const now = new Date();
  const peru = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const dd = String(peru.getUTCDate()).padStart(2, '0');
  const mm = String(peru.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = peru.getUTCFullYear();
  let h = peru.getUTCHours();
  const min = String(peru.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'p. m.' : 'a. m.';
  h = h % 12 || 12;
  return { fecha: `${dd}/${mm}/${yyyy}`, hora: `${h}:${min} ${ampm}` };
}

/**
 * Read key-value config from the origin business Configuracion sheet.
 * Returns an object like { departamento: 'Lima', direccion_tienda: 'Av. ...' }
 */
async function getBusinessConfig(spreadsheetId) {
  try {
    const sheets = new SheetsService(spreadsheetId);
    await sheets.initialize();
    const rows = await sheets.getRows('Configuracion!A:B');
    const config = {};
    for (let i = 1; i < rows.length; i++) {
      const key = (rows[i][0] || '').trim();
      const val = (rows[i][1] || '').toString().trim();
      if (key) config[key] = val;
    }
    return config;
  } catch (e) {
    console.error('[Delivery] Could not read Configuracion sheet:', e.message);
    return {};
  }
}

/**
 * Notify the delivery business when an order is created in an origin business.
 *
 * @param {Object} pedido           - Order data
 * @param {string} pedido.id        - Order ID (e.g. PED-12345678)
 * @param {string} pedido.whatsapp
 * @param {string} pedido.cliente
 * @param {string} pedido.telefono
 * @param {string} pedido.direccion - Delivery destination (customer address)
 * @param {string} pedido.productos - Pre-formatted products string
 * @param {number} pedido.total
 * @param {Object} negocioOrigen    - Full origin business object
 * @param {Object} negociosService  - Negocios service to look up BIZ-005
 */
async function notificarNuevoDelivery(pedido, negocioOrigen, negociosService) {
  console.log(`[Delivery] Hook triggered for business: ${negocioOrigen?.id} (${negocioOrigen?.nombre})`);
  console.log(`[Delivery] configExtra:`, JSON.stringify(negocioOrigen?.configExtra));

  const deliveryBizId = negocioOrigen?.configExtra?.deliveryBizId;
  if (!deliveryBizId) {
    console.log(`[Delivery] No deliveryBizId in configExtra — skipping`);
    return;
  }
  console.log(`[Delivery] deliveryBizId found: ${deliveryBizId}`);

  const negocioDelivery = negociosService.getById(deliveryBizId);
  if (!negocioDelivery) {
    console.error(`[Delivery] Delivery business not found: ${deliveryBizId}`);
    return;
  }

  const { fecha, hora } = getPeruDateTime();
  const deliveryId = `DEL-${Date.now().toString().slice(-8)}`;

  // ── Read origin address from Configuracion sheet ─────────────────────────
  const bizConfig = await getBusinessConfig(negocioOrigen.spreadsheetId);
  const originDepartamento = (bizConfig['departamento'] || '').toLowerCase().trim();
  console.log(`[Delivery] Store config — departamento="${bizConfig['departamento'] || ''}" direccion_tienda="${bizConfig['direccion_tienda'] || ''}"`);
  const originDireccion    = bizConfig['direccion_tienda'] || '';
  const originLabel = [bizConfig['direccion_tienda'], bizConfig['departamento']].filter(Boolean).join(', ') || negocioOrigen.nombre || negocioOrigen.id;
  const originForMap = bizConfig['direccion_tienda'] || '';

  // ── Look up client record from origin business spreadsheet ───────────────
  let destination = (pedido.direccion || '').trim();
  let rawDireccion = destination; // plain street address for map URL (no district/dept)
  let customerCity = (pedido.departamento || pedido.ciudad || '').toLowerCase().trim();

  try {
    const clientSheets = new SheetsService(negocioOrigen.spreadsheetId);
    await clientSheets.initialize();
    const clientRows = await clientSheets.getRows('Clientes!A:V');
    const waClean = (pedido.whatsapp || '').replace(/[^0-9]/g, '');
    for (let i = 1; i < clientRows.length; i++) {
      const rowWa = (clientRows[i][1] || '').replace(/[^0-9]/g, '');
      if (rowWa && rowWa === waClean) {
        const r = clientRows[i];
        // Prefer delivery-specific fields, fall back to main fields
        const clientDireccion    = (r[18] || r[6]  || '').trim(); // direccionEnvio   > direccion      (col S > G)
        const clientDistrito     = (r[19] || r[8]  || '').trim(); // distritoEnvio    > distrito       (col T > I)
        const clientDepartamento = (r[20] || r[7]  || '').trim(); // departamentoEnvio > departamento  (col U > H)
        const clientNombre       = (r[2]  || r[3]  || '').trim(); // nombreNegocio    > nombreResponsable

        if (clientDireccion) {
          rawDireccion = clientDireccion;
          destination = [clientDireccion, clientDistrito].filter(Boolean).join(', ');
        }
        if (clientDepartamento) customerCity = clientDepartamento.toLowerCase().trim();
        console.log(`[Delivery] Client found — nombre="${clientNombre}" direccion="${clientDireccion}" distrito="${clientDistrito}" departamento="${clientDepartamento}"`);
        break;
      }
    }
  } catch (e) {
    console.warn(`[Delivery] Could not look up client record: ${e.message}`);
  }

  // ── Filter 1: customer must have a delivery address ───────────────────────
  if (!destination) {
    console.log(`[Delivery] Skipped — customer has no delivery address`);
    return;
  }

  // ── Filter 2: customer city must match origin city ────────────────────────
  if (!customerCity) {
    console.log(`[Delivery] Skipped — customer city unknown`);
    return;
  }
  if (customerCity !== originDepartamento) {
    console.log(`[Delivery] Skipped — city mismatch: customer="${customerCity}" vs store="${originDepartamento}"`);
    return;
  }
  console.log(`[Delivery] City match OK: "${customerCity}"`);

  // ── 1. Register in the delivery business spreadsheet ─────────────────────
  try {
    const sheets = new SheetsService(negocioDelivery.spreadsheetId);
    await sheets.initialize();

    // Columns: ID, Date, Time, WhatsApp, Client, Phone, Destination,
    //          Products, Total, Status, Notes, Origin, OriginOrderId
    const valores = [
      deliveryId,
      fecha,
      hora,
      (pedido.whatsapp || '').replace(/[^0-9]/g, ''),
      pedido.cliente || '',
      pedido.telefono || '',
      destination,
      pedido.productos || '',
      pedido.total || 0,
      'PENDING',
      '',
      negocioOrigen.nombre || negocioOrigen.id,
      pedido.id || '',
    ];

    await sheets.appendRow('Pedidos', valores);
    console.log(`[Delivery] Delivery registered: ${deliveryId} (origin: ${pedido.id})`);
  } catch (err) {
    console.error(`[Delivery] Error registering in sheets:`, err.message);
    return;
  }

  // ── 2. Broadcast to all couriers (clients of the delivery business) ───────
  try {
    const sheetsDelivery = new SheetsService(negocioDelivery.spreadsheetId);
    await sheetsDelivery.initialize();

    const filas = await sheetsDelivery.getRows('Clientes!A:I');
    if (!filas || filas.length <= 1) {
      console.log('[Delivery] No couriers registered in Clients sheet');
      return;
    }

    const destinationForMap = rawDireccion;
    const mapsUrl = `https://www.google.com/maps/dir/${encodeURIComponent(originForMap)}/${encodeURIComponent(destinationForMap)}`;

    const body =
      `*Nuevo delivery disponible*\n\n` +
      `Tienda: *${negocioOrigen.nombre || negocioOrigen.id}*\n` +
      `Origen: ${originLabel}\n` +
      `Destino: ${destination}\n` +
      `Productos: ${pedido.productos || ''}\n\n` +
      `Ruta: ${mapsUrl}`;

    const buttons = [{ id: `delivery_yes_${pedido.id}`, title: 'Si, lo tomo' }];

    const whatsappService = new WhatsAppService(negocioDelivery.whatsapp);

    const envios = [];
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      const numero = (fila[1] || fila[0] || '').toString().replace(/[^0-9]/g, '');
      if (numero.length >= 9) {
        envios.push(
          whatsappService.sendButtonMessage(numero, body, buttons)
            .catch(() => whatsappService.sendMessage(numero, body + '\n\n¿Te interesa? Responde *SI* para confirmar.'))
            .then(() => console.log(`[Delivery] Notified courier: ${numero}`))
            .catch(e => console.error(`[Delivery] Error sending to ${numero}:`, e.message))
        );
      }
    }

    await Promise.allSettled(envios);
    console.log(`[Delivery] Broadcast complete: ${envios.length} courier(s)`);
  } catch (err) {
    console.error(`[Delivery] Error in broadcast:`, err.message);
  }
}

module.exports = { notificarNuevoDelivery };
