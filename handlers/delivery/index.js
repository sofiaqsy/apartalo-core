/**
 * DELIVERY HANDLER
 *
 * Handles messages from couriers (clients of the delivery business, e.g. BIZ-005).
 * Couriers are NOT customers — they claim and complete delivery jobs.
 *
 * Supported intents:
 *   - "ya entregue / entregado / lo entregué" → mark active order as COMPLETADO
 *   - "mis pedidos / qué tengo" → list active delivery orders
 *   - anything else → friendly guide message
 */

// Keywords that mean the courier completed a delivery
const ENTREGADO_KEYWORDS = [
  'ya entregue', 'entregue', 'ya entregué', 'entregué',
  'lo entregue', 'lo entregué', 'delivery entregado',
  'entregado', 'ya lo entregué', 'ya lo entregue',
  'listo', 'completado', 'termine', 'terminé',
];

// Keywords to list active orders
const MIS_PEDIDOS_KEYWORDS = [
  'mis pedidos', 'mis deliveries', 'qué tengo', 'que tengo',
  'tengo pedidos', 'mis órdenes', 'mis ordenes',
];

function matchesAny(text, keywords) {
  const t = (text || '').toLowerCase().trim();
  return keywords.some(k => t.includes(k));
}

/**
 * @param {string} from   - Courier's WhatsApp number
 * @param {string} text   - Message text
 * @param {Object} context - { whatsapp, sheets, negocio }
 */
async function handle(from, text, context) {
  const { whatsapp, sheets } = context;
  const waClean = from.replace(/[^0-9]/g, '');

  console.log(`[DeliveryHandler] Message from courier ${from}: "${text}"`);

  // ── Delivery completed ────────────────────────────────────────────────────
  if (matchesAny(text, ENTREGADO_KEYWORDS)) {
    // Find courier's active (PENDIENTE) orders in Pedidos
    // Pedidos cols: id(0) fecha(1) hora(2) whatsapp(3) ... estado(9) ... tipoEnvio(12)
    const rows = await sheets.getRows('Pedidos!A:M');

    const activeOrders = [];
    for (let i = 1; i < rows.length; i++) {
      const rowWa = (rows[i][3] || '').replace(/[^0-9]/g, '');
      const estado = (rows[i][9] || '').toUpperCase();
      const tipoEnvio = (rows[i][12] || '').toUpperCase();
      if (rowWa === waClean && estado === 'PENDIENTE' && tipoEnvio === 'DELIVERY') {
        activeOrders.push({ rowIndex: i + 1, id: rows[i][0], observaciones: rows[i][11] || '' });
      }
    }

    if (activeOrders.length === 0) {
      await whatsapp.sendMessage(from, 'No tienes deliveries activos en este momento.');
      return;
    }

    if (activeOrders.length === 1) {
      const order = activeOrders[0];
      await sheets.updateCell(`Pedidos!J${order.rowIndex}`, 'COMPLETADO');
      console.log(`[DeliveryHandler] Order ${order.id} marked COMPLETADO by courier ${from}`);
      await whatsapp.sendMessage(from,
        `✅ ¡Perfecto! Delivery *${order.id}* marcado como entregado.\n\n` +
        `${order.observaciones ? order.observaciones + '\n\n' : ''}` +
        `Gracias por tu trabajo. Espera el siguiente delivery.`
      );
      return;
    }

    // Multiple active orders — ask which one
    const lista = activeOrders.map((o, i) =>
      `${i + 1}. ${o.id}\n   ${o.observaciones}`
    ).join('\n\n');
    await whatsapp.sendMessage(from,
      `Tienes ${activeOrders.length} deliveries activos. ¿Cuál entregaste?\n\n${lista}\n\nResponde con el número (1, 2, etc.) o el código del pedido.`
    );
    return;
  }

  // ── List active orders ────────────────────────────────────────────────────
  if (matchesAny(text, MIS_PEDIDOS_KEYWORDS)) {
    const rows = await sheets.getRows('Pedidos!A:M');
    const activos = [];
    for (let i = 1; i < rows.length; i++) {
      const rowWa = (rows[i][3] || '').replace(/[^0-9]/g, '');
      const estado = (rows[i][9] || '').toUpperCase();
      const tipoEnvio = (rows[i][12] || '').toUpperCase();
      if (rowWa === waClean && estado === 'PENDIENTE' && tipoEnvio === 'DELIVERY') {
        activos.push(`• *${rows[i][0]}*\n  ${rows[i][11] || ''}`);
      }
    }

    if (activos.length === 0) {
      await whatsapp.sendMessage(from, 'No tienes deliveries activos en este momento.');
    } else {
      await whatsapp.sendMessage(from,
        `Tus deliveries activos (${activos.length}):\n\n${activos.join('\n\n')}`
      );
    }
    return;
  }

  // ── Check if it's a number reply to select which order was delivered ──────
  const num = parseInt((text || '').trim());
  if (!isNaN(num)) {
    const rows = await sheets.getRows('Pedidos!A:M');
    const activos = [];
    for (let i = 1; i < rows.length; i++) {
      const rowWa = (rows[i][3] || '').replace(/[^0-9]/g, '');
      const estado = (rows[i][9] || '').toUpperCase();
      const tipoEnvio = (rows[i][12] || '').toUpperCase();
      if (rowWa === waClean && estado === 'PENDIENTE' && tipoEnvio === 'DELIVERY') {
        activos.push({ rowIndex: i + 1, id: rows[i][0], observaciones: rows[i][11] || '' });
      }
    }
    const order = activos[num - 1];
    if (order) {
      await sheets.updateCell(`Pedidos!J${order.rowIndex}`, 'COMPLETADO');
      console.log(`[DeliveryHandler] Order ${order.id} marked COMPLETADO by courier ${from}`);
      await whatsapp.sendMessage(from,
        `✅ Delivery *${order.id}* marcado como entregado. ¡Gracias!`
      );
      return;
    }
  }

  // ── Default: guide the courier ────────────────────────────────────────────
  await whatsapp.sendMessage(from,
    `Hola 👋 Soy el sistema de delivery.\n\n` +
    `Puedes escribirme:\n` +
    `• *"Ya entregué"* — para marcar tu delivery como completado\n` +
    `• *"Mis pedidos"* — para ver tus deliveries activos`
  );
}

module.exports = { handle };
