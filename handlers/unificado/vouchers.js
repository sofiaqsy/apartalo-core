/**
 * APARTALO CORE - Handler Unificado - Vouchers v2
 *
 * Fix: si hay más de 1 pedido activo al recibir imagen, preguntar primero a cuál corresponde.
 */

const DriveService = require('../../core/services/drive-service');
const { parsearDetallePedido } = require('./utils');
const { ESTADOS_FINALIZADOS } = require('./constants');

const driveService = new DriveService();

/**
 * Manejar imagen recibida.
 * Si hay >1 pedido activo → guardar imagen en estado y preguntar a cuál corresponde.
 * Si hay 1 pedido activo → procesar directamente.
 */
async function manejarImagenRecibida(from, mediaId, caption, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('📸 Imagen recibida de ' + from);

  let pedidosActivos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = pedidos.filter(p => !ESTADOS_FINALIZADOS.includes(p.estado));
  } catch (e) {
    console.log('⚠️ Error buscando pedidos:', e.message);
  }

  if (pedidosActivos.length === 0) {
    await whatsapp.sendMessage(from,
      'Recibí tu imagen, pero no tienes pedidos activos pendientes de pago.\n\n' +
      'Si deseas hacer un pedido, dime qué necesitas.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  // Si hay más de 1 pedido activo, preguntar a cuál pertenece el voucher
  if (pedidosActivos.length > 1) {
    // Guardar el mediaId temporalmente para procesarlo luego
    stateManager.updateData(from, negocio.id, {
      voucherPendienteMediaId: mediaId,
      voucherPendienteCaption: caption,
      pedidosActivos
    });
    stateManager.setStep(from, negocio.id, 'seleccionar_pedido_voucher');

    let mensaje = 'Recibí tu comprobante.\n\n';
    mensaje += 'Tienes ' + pedidosActivos.length + ' pedidos activos. ¿A cuál corresponde este pago?\n\n';
    pedidosActivos.forEach((p, idx) => {
      const d = parsearDetallePedido(p);
      mensaje += `${idx + 1}. ${d.producto} — S/${d.total.toFixed(2)} (${p.id})\n`;
    });
    mensaje += '\nResponde con el número (1, 2, etc.)';

    await whatsapp.sendMessage(from, mensaje);
    return;
  }

  // Un solo pedido activo → procesar directo
  await procesarVoucher(from, mediaId, caption, pedidosActivos[0], context);
}

/**
 * Procesar y guardar voucher para un pedido específico
 */
async function procesarVoucher(from, mediaId, caption, pedidoActivo, context) {
  const { whatsapp, sheets, negocio, stateManager, firebaseService } = context;

  try {
    const mediaData = await whatsapp.downloadMedia(mediaId);
    const fileName = `voucher_${pedidoActivo.id}_${Date.now()}.jpg`;
    const uploadResult = await driveService.uploadImage(
      mediaData.data,
      fileName,
      mediaData.contentType || 'image/jpeg',
      negocio.id
    );

    console.log('✅ Voucher subido:', uploadResult.url);

    await guardarEvidenciaPedido(sheets, pedidoActivo.id, {
      url: uploadResult.url,
      tipo: 'WHATSAPP',
      fecha: new Date().toISOString(),
      descripcion: caption || 'Comprobante enviado por WhatsApp'
    });

    if (firebaseService) {
      await firebaseService.notificarVoucherRecibido(negocio.id, pedidoActivo);
    }

    const detalle = parsearDetallePedido(pedidoActivo);
    await whatsapp.sendMessage(from,
      'COMPROBANTE RECIBIDO\n\n' +
      `Pedido: ${pedidoActivo.id}\n` +
      `${detalle.producto}\n` +
      `Total: S/${detalle.total.toFixed(2)}\n\n` +
      'Tu comprobante ha sido guardado. Gracias.'
    );

    stateManager.resetState(from, negocio.id);
  } catch (error) {
    console.error('❌ Error procesando voucher:', error.message);
    await whatsapp.sendMessage(from,
      'Hubo un problema guardando tu comprobante. Por favor intenta de nuevo.'
    );
  }
}

/**
 * Guardar evidencia de pago en el pedido
 */
async function guardarEvidenciaPedido(sheets, pedidoId, evidencia) {
  try {
    const rows = await sheets.getRows('Pedidos!A:K');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        let evidencias = [];
        const raw = rows[i][10] || '';
        if (raw) {
          try {
            evidencias = JSON.parse(raw);
            if (!Array.isArray(evidencias)) evidencias = [];
          } catch {
            if (raw.startsWith('http')) evidencias = [{ id: 'ev_legacy', url: raw, tipo: 'WHATSAPP', fecha: new Date().toISOString(), descripcion: 'Comprobante migrado' }];
          }
        }
        evidencias.push({ id: `ev_${Date.now()}`, ...evidencia });
        await sheets.updateCell(`Pedidos!K${i + 1}`, JSON.stringify(evidencias));
        console.log('✅ Evidencia guardada en pedido ' + pedidoId);
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('❌ Error guardando evidencia:', error.message);
    return false;
  }
}

/**
 * Iniciar flujo de envío de voucher (cuando el cliente escribe "pagar", etc.)
 */
async function iniciarEnvioVoucher(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  let pedidosActivos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = pedidos.filter(p => !ESTADOS_FINALIZADOS.includes(p.estado));
  } catch (e) {}

  if (pedidosActivos.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos activos.\n\nDime qué necesitas y te ayudo.');
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  if (pedidosActivos.length === 1) {
    const detalle = parsearDetallePedido(pedidosActivos[0]);
    await whatsapp.sendMessage(from,
      'ENVIAR COMPROBANTE\n\n' +
      `Pedido: ${pedidosActivos[0].id}\n` +
      `${detalle.producto}\n` +
      `Total: S/${detalle.total.toFixed(2)}\n\n` +
      'Envía una foto de tu comprobante de pago.'
    );
    stateManager.updateData(from, negocio.id, { pedidoSeleccionado: pedidosActivos[0].id });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  // Múltiples pedidos — listar y pedir selección
  let mensaje = 'SELECCIONA EL PEDIDO\n\n';
  pedidosActivos.forEach((p, idx) => {
    const d = parsearDetallePedido(p);
    mensaje += `${idx + 1}. ${d.producto} — S/${d.total.toFixed(2)} (${p.id})\n`;
  });
  mensaje += '\nResponde con el número del pedido (1, 2, etc.)';

  await whatsapp.sendMessage(from, mensaje);
  stateManager.updateData(from, negocio.id, { pedidosActivos });
  stateManager.setStep(from, negocio.id, 'seleccionar_pedido_voucher');
}

/**
 * Manejar selección de pedido para voucher
 * Funciona tanto cuando el cliente eligió pedido ANTES de enviar imagen (iniciarEnvioVoucher)
 * como DESPUÉS de enviarla (manejarImagenRecibida con múltiples pedidos).
 */
async function manejarSeleccionPedidoVoucher(from, text, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const pedidosActivos = state.data?.pedidosActivos || [];
  const voucherPendienteMediaId = state.data?.voucherPendienteMediaId || null;
  const voucherPendienteCaption = state.data?.voucherPendienteCaption || '';

  const numero = parseInt(text);
  if (isNaN(numero) || numero < 1 || numero > pedidosActivos.length) {
    await whatsapp.sendMessage(from, `Por favor responde con un número del 1 al ${pedidosActivos.length}.`);
    return;
  }

  const pedidoSeleccionado = pedidosActivos[numero - 1];

  // Si ya tenemos el voucher guardado, procesarlo directamente
  if (voucherPendienteMediaId) {
    await procesarVoucher(from, voucherPendienteMediaId, voucherPendienteCaption, pedidoSeleccionado, context);
    return;
  }

  // Si no hay voucher aún, pedir que lo envíen
  const detalle = parsearDetallePedido(pedidoSeleccionado);
  await whatsapp.sendMessage(from,
    'ENVIAR COMPROBANTE\n\n' +
    `Pedido: ${pedidoSeleccionado.id}\n` +
    `${detalle.producto}\n` +
    `Total: S/${detalle.total.toFixed(2)}\n\n` +
    'Envía una foto de tu comprobante.'
  );
  stateManager.updateData(from, negocio.id, { pedidoSeleccionado: pedidoSeleccionado.id });
  stateManager.setStep(from, negocio.id, 'esperando_voucher');
}

/**
 * Estado esperando_voucher — cliente debe enviar imagen
 */
async function manejarVoucher(from, message, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  const { type, mediaId, text } = message;

  if (type === 'text') {
    const textoLower = (text || '').toLowerCase();
    if (textoLower === 'menu' || textoLower === 'cancelar') {
      stateManager.resetState(from, negocio.id);
      await whatsapp.sendMessage(from, 'Operación cancelada.');
      return;
    }
    await whatsapp.sendMessage(from, 'Por favor envía una foto de tu comprobante de pago.');
    return;
  }

  if (type !== 'image' || !mediaId) {
    await whatsapp.sendMessage(from, 'Necesito una imagen del comprobante.');
    return;
  }

  return await manejarImagenRecibida(from, mediaId, text || '', context, cfg);
}

module.exports = {
  manejarImagenRecibida,
  iniciarEnvioVoucher,
  manejarSeleccionPedidoVoucher,
  manejarVoucher
};
