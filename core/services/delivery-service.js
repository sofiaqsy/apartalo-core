/**
 * DELIVERY SERVICE
 *
 * Cuando se crea un pedido en un negocio con `configExtra.deliveryBizId`,
 * este servicio:
 *   1. Registra el pedido como delivery en el spreadsheet del negocio delivery
 *   2. Hace broadcast por WhatsApp a todos los repartidores (clientes de delivery)
 *
 * Configuración en configExtra del negocio origen:
 *   { "deliveryBizId": "BIZ-005" }
 */

const SheetsService = require('./sheets-service');
const WhatsAppService = require('./whatsapp-service');

/**
 * Obtener hora actual en zona horaria Perú (UTC-5)
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
 * Notificar al negocio delivery cuando se crea un pedido en un negocio origen.
 *
 * @param {Object} pedido         - Datos del pedido recién creado
 * @param {string} pedido.id      - ID del pedido (ej. PED-12345678)
 * @param {string} pedido.whatsapp
 * @param {string} pedido.cliente
 * @param {string} pedido.telefono
 * @param {string} pedido.direccion
 * @param {string} pedido.productos - String ya formateado
 * @param {number} pedido.total
 * @param {Object} negocioOrigen  - Objeto negocio completo (con configExtra, nombre, whatsapp, etc.)
 * @param {Object} negociosService - Instancia del servicio de negocios para obtener BIZ-005
 */
async function notificarNuevoDelivery(pedido, negocioOrigen, negociosService) {
  const deliveryBizId = negocioOrigen?.configExtra?.deliveryBizId;
  if (!deliveryBizId) return; // Este negocio no usa delivery

  const negocioDelivery = negociosService.getById(deliveryBizId);
  if (!negocioDelivery) {
    console.error(`[Delivery] No se encontró el negocio delivery: ${deliveryBizId}`);
    return;
  }

  const { fecha, hora } = getPeruDateTime();
  const deliveryId = `DEL-${Date.now().toString().slice(-8)}`;

  // ── 1. Registrar en el spreadsheet del negocio delivery ──────────────────
  try {
    const sheets = new SheetsService(negocioDelivery.spreadsheetId);
    await sheets.initialize();

    // Columnas: ID, Fecha, Hora, WhatsApp, Cliente, Teléfono, Dirección,
    //           Productos, Total, Estado, Observaciones, Origen, PedidoOrigenId
    const valores = [
      deliveryId,
      fecha,
      hora,
      (pedido.whatsapp || '').replace(/[^0-9]/g, ''),
      pedido.cliente || '',
      pedido.telefono || '',
      pedido.direccion || '',
      pedido.productos || '',
      pedido.total || 0,
      'PENDIENTE',
      '',
      negocioOrigen.nombre || negocioOrigen.id,
      pedido.id || '',
    ];

    await sheets.appendRow('Pedidos', valores);
    console.log(`[Delivery] ✅ Delivery registrado: ${deliveryId} (origen: ${pedido.id})`);
  } catch (err) {
    console.error(`[Delivery] ❌ Error registrando en sheets:`, err.message);
    return; // Si no se pudo registrar, no continuar con el broadcast
  }

  // ── 2. Broadcast a todos los repartidores (clientes de BIZ-005) ──────────
  try {
    const sheetsDelivery = new SheetsService(negocioDelivery.spreadsheetId);
    await sheetsDelivery.initialize();

    // La hoja Clientes tiene: WhatsApp en col A (o D según configuración)
    // Usamos getRows para obtener todos y buscar la columna de WhatsApp
    const filas = await sheetsDelivery.getRows('Clientes!A:I');
    if (!filas || filas.length <= 1) {
      console.log('[Delivery] Sin repartidores registrados en Clientes');
      return;
    }

    const mensaje =
      `🚚 *Nuevo delivery disponible*\n\n` +
      `📦 De: *${negocioOrigen.nombre || negocioOrigen.id}*\n` +
      `👤 Cliente: ${pedido.cliente || 'Sin nombre'}\n` +
      `📍 Dirección: ${pedido.direccion || 'Sin dirección'}\n` +
      `🛍️ Productos: ${pedido.productos || ''}\n` +
      `💰 Total: *S/ ${Number(pedido.total || 0).toFixed(2)}*\n\n` +
      `¿Te interesa tomarlo? Responde *SÍ* para confirmarlo.`;

    const whatsappService = new WhatsAppService(negocioDelivery.whatsapp);

    // Fila 0 = encabezados, fila 1+ = datos
    // Detectar columna de WhatsApp (col B = index 1, pero puede variar)
    // Por convención en apartalo-core, col B (index 1) es el número WhatsApp
    const envios = [];
    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      const numero = (fila[1] || fila[0] || '').toString().replace(/[^0-9]/g, '');
      if (numero.length >= 9) {
        envios.push(
          whatsappService.sendMessage(numero, mensaje)
            .then(() => console.log(`[Delivery] 📲 Notificado repartidor: ${numero}`))
            .catch(e => console.error(`[Delivery] ⚠️ Error enviando a ${numero}:`, e.message))
        );
      }
    }

    await Promise.allSettled(envios);
    console.log(`[Delivery] ✅ Broadcast completado: ${envios.length} repartidores`);
  } catch (err) {
    console.error(`[Delivery] ❌ Error en broadcast:`, err.message);
  }
}

module.exports = { notificarNuevoDelivery };
