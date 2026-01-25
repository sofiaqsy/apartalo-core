/**
 * APARTALO CORE - Handler Unificado - Vouchers
 * 
 * Módulo para manejo de comprobantes de pago
 */

const DriveService = require('../../core/services/drive-service');
const { parsearDetallePedido } = require('./utils');
const { ESTADOS_FINALIZADOS } = require('./constants');

const driveService = new DriveService();

/**
 * Manejar imagen recibida - detectar si es voucher
 */
async function manejarImagenRecibida(from, mediaId, caption, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio, firebaseService } = context;

  console.log('📸 Imagen recibida de ' + from);

  // Buscar pedidos activos del cliente (excluir finalizados)
  let pedidosActivos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = pedidos.filter(p => !ESTADOS_FINALIZADOS.includes(p.estado));
  } catch (e) {
    console.log('⚠️ Error buscando pedidos:', e.message);
  }

  // Si no hay pedido activo, informar
  if (pedidosActivos.length === 0) {
    await whatsapp.sendMessage(from,
      'Recibí tu imagen.\n\n' +
      'Si es un comprobante de pago, primero necesitas tener un pedido activo.\n\n' +
      'Escribe lo que necesitas y te ayudo a crear tu pedido.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  // Usar el pedido más reciente
  const pedidoActivo = pedidosActivos[0];

  // Procesar como voucher
  try {
    // Descargar imagen de WhatsApp
    const mediaData = await whatsapp.downloadMedia(mediaId);
    
    // Subir a Google Drive
    const fileName = `voucher_${pedidoActivo.id}_${Date.now()}.jpg`;
    const uploadResult = await driveService.uploadImage(
      mediaData.data,
      fileName,
      mediaData.contentType || 'image/jpeg',
      negocio.id
    );

    console.log('✅ Voucher subido:', uploadResult.url);

    // Guardar evidencia en el pedido
    await guardarEvidenciaPedido(sheets, pedidoActivo.id, {
      url: uploadResult.url,
      tipo: 'WHATSAPP',
      fecha: new Date().toISOString(),
      descripcion: caption || 'Comprobante enviado por WhatsApp'
    });

    // Notificar al negocio
    if (firebaseService) {
      await firebaseService.notificarVoucherRecibido(negocio.id, pedidoActivo);
    }

    // Confirmar al cliente
    const detalle = parsearDetallePedido(pedidoActivo);
    
    await whatsapp.sendMessage(from,
      '✅ COMPROBANTE RECIBIDO\n\n' +
      detalle.producto + '\n' +
      'Cantidad: ' + detalle.cantidad + '\n' +
      'Precio unitario: S/' + detalle.precioUnitario.toFixed(2) + '\n' +
      'Total: S/' + detalle.total.toFixed(2) + '\n\n' +
      'Tu comprobante ha sido guardado.\n\n' +
      'Gracias.'
    );

    stateManager.resetState(from, negocio.id);

  } catch (error) {
    console.error('❌ Error procesando voucher:', error.message);
    
    await whatsapp.sendMessage(from,
      'Hubo un problema guardando tu comprobante.\n\n' +
      'Por favor intenta enviarlo de nuevo.'
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
        const voucherUrlsRaw = rows[i][10] || '';
        
        if (voucherUrlsRaw) {
          try {
            evidencias = JSON.parse(voucherUrlsRaw);
            if (!Array.isArray(evidencias)) evidencias = [];
          } catch (e) {
            if (voucherUrlsRaw.startsWith('http')) {
              evidencias = [{
                id: 'ev_legacy',
                url: voucherUrlsRaw,
                tipo: 'WHATSAPP',
                fecha: new Date().toISOString(),
                descripcion: 'Comprobante migrado'
              }];
            }
          }
        }
        
        evidencias.push({
          id: `ev_${Date.now()}`,
          ...evidencia
        });
        
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
 * Iniciar flujo de envío de voucher
 */
async function iniciarEnvioVoucher(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  let pedidosActivos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = pedidos.filter(p => !ESTADOS_FINALIZADOS.includes(p.estado));
  } catch (e) {}

  if (pedidosActivos.length === 0) {
    await whatsapp.sendMessage(from, 
      'No tienes pedidos activos.\n\n' +
      'Dime qué necesitas y te ayudo a crear tu pedido.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  // Si hay un solo pedido, ir directo
  if (pedidosActivos.length === 1) {
    const pedido = pedidosActivos[0];
    const detalle = parsearDetallePedido(pedido);
    
    await whatsapp.sendMessage(from, 
      'ENVIAR COMPROBANTE DE PAGO\n\n' +
      detalle.producto + '\n' +
      'Total a pagar: S/' + detalle.total.toFixed(2) + '\n\n' +
      'Envía una foto de tu voucher, captura de Yape/Plin o comprobante de transferencia.'
    );
    stateManager.updateData(from, negocio.id, { pedidoSeleccionado: pedido.id });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  // Si hay varios, listar
  let mensaje = 'SELECCIONA EL PEDIDO\n\n';
  mensaje += 'Tienes ' + pedidosActivos.length + ' pedidos activos:\n\n';
  
  pedidosActivos.forEach((p, idx) => {
    const detalle = parsearDetallePedido(p);
    mensaje += (idx + 1) + '. ' + detalle.producto + '\n';
    mensaje += '   Total: S/' + detalle.total.toFixed(2) + '\n\n';
  });
  
  mensaje += 'Responde con el número del pedido (1, 2, etc.)';

  await whatsapp.sendMessage(from, mensaje);
  stateManager.updateData(from, negocio.id, { pedidosActivos });
  stateManager.setStep(from, negocio.id, 'seleccionar_pedido_voucher');
}

/**
 * Manejar selección de pedido para voucher
 */
async function manejarSeleccionPedidoVoucher(from, text, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const pedidosActivos = state.data?.pedidosActivos || [];

  const numero = parseInt(text);
  
  if (isNaN(numero) || numero < 1 || numero > pedidosActivos.length) {
    await whatsapp.sendMessage(from, 
      'Por favor responde con un número válido (1 a ' + pedidosActivos.length + ').'
    );
    return;
  }

  const pedidoSeleccionado = pedidosActivos[numero - 1];
  const detalle = parsearDetallePedido(pedidoSeleccionado);
  
  await whatsapp.sendMessage(from, 
    'ENVIAR COMPROBANTE DE PAGO\n\n' +
    detalle.producto + '\n' +
    'Total a pagar: S/' + detalle.total.toFixed(2) + '\n\n' +
    'Envía una foto de tu voucher.'
  );
  
  stateManager.updateData(from, negocio.id, { pedidoSeleccionado: pedidoSeleccionado.id });
  stateManager.setStep(from, negocio.id, 'esperando_voucher');
}

/**
 * Manejar estado esperando_voucher
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
    
    await whatsapp.sendMessage(from, 
      'Por favor, envía una foto de tu comprobante de pago.'
    );
    return;
  }

  if (type !== 'image' || !mediaId) {
    await whatsapp.sendMessage(from, 
      'Necesito una imagen del comprobante.'
    );
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
