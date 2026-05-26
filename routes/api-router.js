/**
 * APARTALO CORE - API Routes
 *
 * Negocios con plataformaExterna=true usan Supabase (SupabaseSheetsAdapter).
 * Google Sheets eliminado como fuente de datos principal.
 * Recetas, Conversaciones y Delivery aún usan sus propios routers separados.
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const WhatsAppService = require('../core/services/whatsapp-service');
const SupabaseSheetsAdapter = require('../core/services/supabase-sheets-adapter');
const supabaseService = require('../core/services/supabase-service');
const firebaseService = require('../core/services/firebase-service');

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// All negocios are now plataformaExterna=true — always returns the Supabase adapter
async function getSheetsService(negocio) {
  const sheets = new SupabaseSheetsAdapter(negocio.farmId, negocio.spreadsheetId);
  await sheets.initialize();
  return sheets;
}

// Kept for routes that truly have no Supabase equivalent yet (recetas, etc.)
// Returns the Supabase adapter — will return empty stubs for unimplemented entities
async function getSheetsServiceDirect(negocio) {
  return getSheetsService(negocio);
}
const deliveryService = require('../core/services/delivery-service');

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const str = String(value).trim().replace(',', '.');
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

function getPeruDateTime() {
  const now = new Date();
  const peruTime = new Date(now.getTime() - (5 * 60 * 60 * 1000));
  const day = String(peruTime.getUTCDate()).padStart(2, '0');
  const month = String(peruTime.getUTCMonth() + 1).padStart(2, '0');
  const year = peruTime.getUTCFullYear();
  let hours = peruTime.getUTCHours();
  const minutes = String(peruTime.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'p. m.' : 'a. m.';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return { fecha: `${day}/${month}/${year}`, hora: `${hours}:${minutes} ${ampm}` };
}

function formatPeruDate() {
  return getPeruDateTime().fecha;
}

// ==================== PUSH NOTIFICATIONS ====================

/**
 * Registrar token FCM para push notifications
 * POST /api/push-token/:businessId
 */
router.post('/push-token/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { token, platform, appVersion } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Campo requerido: token' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    // Inicializar Firebase si no está inicializado
    await firebaseService.initialize();

    const result = await firebaseService.guardarTokenPush(businessId, token, {
      platform: platform || 'unknown',
      appVersion: appVersion || '1.0.0'
    });

    if (result) {
      console.log(`✅ Token FCM registrado para ${businessId}`);
      res.status(201).json({ 
        success: true, 
        mensaje: 'Token registrado correctamente' 
      });
    } else {
      res.status(500).json({ error: 'Error guardando token' });
    }
  } catch (error) {
    console.error('❌ Error registrando token FCM:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Eliminar token FCM (al cerrar sesión)
 * DELETE /api/push-token/:businessId
 */
router.delete('/push-token/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Campo requerido: token' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await firebaseService.initialize();
    const result = await firebaseService.eliminarTokenPush(businessId, token);

    res.json({ 
      success: result, 
      mensaje: result ? 'Token eliminado' : 'Token no encontrado' 
    });
  } catch (error) {
    console.error('❌ Error eliminando token FCM:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Enviar notificación de prueba
 * POST /api/push-token/:businessId/test
 */
router.post('/push-token/:businessId/test', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { title, body } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await firebaseService.initialize();
    const result = await firebaseService.enviarNotificacion(businessId, {
      title: title || '🔔 Prueba de Notificación',
      body: body || 'Esta es una notificación de prueba desde ApartaLo',
      data: { type: 'test' }
    });

    res.json({ 
      success: true, 
      enviados: result.success,
      fallidos: result.failure
    });
  } catch (error) {
    console.error('❌ Error enviando notificación:', error);
    res.status(500).json({ error: error.message });
  }
});

// MENSAJES
router.post('/mensaje', async (req, res) => {
  try {
    const { businessId, to, message, conversacionId } = req.body;
    if (!businessId || !to || !message) {
      return res.status(400).json({ error: 'Faltan campos requeridos: businessId, to, message' });
    }
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendMessage(to, message);

    if (conversacionId) {
      const sheets = await getSheetsService(negocio);
      await sheets.appendRow('Mensajes', [`MSG-${Date.now()}`, conversacionId, new Date().toISOString(), 'ASESOR', message, negocio.nombre]);
    }

    res.json({ success: true, messageId: result.messages?.[0]?.id, to, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/mensaje/imagen', async (req, res) => {
  try {
    const { businessId, to, imageUrl, caption } = req.body;
    if (!businessId || !to || !imageUrl) return res.status(400).json({ error: 'Faltan campos' });
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendImage(to, imageUrl, caption || '');
    res.json({ success: true, messageId: result.messages?.[0]?.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/mensaje/botones', async (req, res) => {
  try {
    const { businessId, to, text, buttons } = req.body;
    if (!businessId || !to || !text || !buttons) return res.status(400).json({ error: 'Faltan campos' });
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendButtonMessage(to, text, buttons);
    res.json({ success: true, messageId: result.messages?.[0]?.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CONVERSACIONES
router.get('/conversaciones/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Conversaciones_Asesor!A:F');

    const conversaciones = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const estadoConv = row[4] || '';
      if (!estado || estadoConv === estado) {
        conversaciones.push({ id: row[0], fecha: row[1], cliente: row[2], whatsapp: row[3], estado: estadoConv, ultimaActividad: row[5] });
      }
    }
    res.json({ total: conversaciones.length, conversaciones });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/conversaciones/:businessId/:conversacionId/mensajes', async (req, res) => {
  try {
    const { businessId, conversacionId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Mensajes!A:F');

    const mensajes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[1] === conversacionId) {
        mensajes.push({ id: row[0], conversacionId: row[1], timestamp: row[2], tipo: row[3], mensaje: row[4], de: row[5] });
      }
    }
    mensajes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ conversacionId, total: mensajes.length, mensajes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/conversaciones/:businessId/:conversacionId', async (req, res) => {
  try {
    const { businessId, conversacionId } = req.params;
    const { estado } = req.body;
    if (!estado) return res.status(400).json({ error: 'Falta campo: estado' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Conversaciones_Asesor!A:E');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === conversacionId) {
        await sheets.updateCell(`Conversaciones_Asesor!E${i + 1}`, estado);
        return res.json({ success: true, conversacionId, nuevoEstado: estado });
      }
    }
    res.status(404).json({ error: 'Conversación no encontrada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PEDIDOS
router.get('/pedidos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, vista, cliente, pagina = 1, limite = 50 } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna && negocio.farmId) {
      const result = await supabaseService.getOrdersByFarm(negocio.farmId, { vista, estado, cliente, pagina, limite });
      return res.json(result);
    }

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Pedidos!A:S');

    const pedidos = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;
      const estadoPedido = row[9] || '';
      if (estado && estadoPedido !== estado) continue;

      pedidos.push({
        id: row[0] || '', fecha: row[1] || '', hora: row[2] || '', whatsapp: row[3] || '',
        cliente: row[4] || '', telefono: row[5] || '', direccion: row[6] || '',
        productos: row[7] || '', total: parseDecimal(row[8]), estado: estadoPedido,
        voucherUrls: row[10] || '', observaciones: row[11] || '',
        departamento: row[12] || '', ciudad: row[13] || '', tipoEnvio: row[14] || '',
        metodoEnvio: row[15] || '', detalleEnvio: row[16] || '', costoEnvio: parseDecimal(row[17]),
        origen: row[18] || 'APP'
      });
    }
    pedidos.reverse();
    res.json({ total: pedidos.length, pedidos });
  } catch (error) {
    console.error('❌ Error obteniendo pedidos:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/pedidos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { whatsapp, cliente, telefono, direccion, productos, total, observaciones, estado, origen, notificarCliente, departamento, ciudad, tipoEnvio, empresaEnvio, costoEnvio } = req.body;

    if (!whatsapp || !productos || total === undefined) {
      return res.status(400).json({ error: 'Campos requeridos: whatsapp, productos, total' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const totalNumeroGlobal = parseDecimal(total);
    const costoEnvioGlobal  = parseDecimal(costoEnvio);
    const estadoFinalGlobal = estado || 'PENDIENTE';
    const origenFinalGlobal = origen || 'APP';

    if (negocio.plataformaExterna && negocio.farmId) {
      const sheets = await getSheetsService(negocio);
      const productosDetalle = Array.isArray(productos) ? productos.map(p => ({
        codigo: p.codigo || p.id,
        nombre: p.nombre || p.name,
        precio: p.precio || p.price || 0,
        cantidad: p.cantidad || p.quantity || 1,
        subtotal: p.subtotal || (p.precio || 0) * (p.cantidad || 1),
        unit: p.unit || p.unidad || 'unidad',
        presentacionId: p.presentacionId || null,
        grind: p.grind || null
      })) : [];

      const result = await sheets.crearPedido({
        whatsapp, cliente, telefono, direccion, ciudad, departamento,
        tipoEnvio, empresaEnvio, observaciones, origen: origenFinalGlobal,
        costoEnvio: costoEnvioGlobal,
        total: totalNumeroGlobal,
        productosDetalle
      });

      if (!result) return res.status(500).json({ error: 'Error creando pedido' });

      try {
        await firebaseService.initialize();
        await firebaseService.enviarNotificacion(businessId, {
          title: '🛒 Nuevo Pedido',
          body: `${cliente || 'Cliente'} - S/ ${totalNumeroGlobal.toFixed(2)}`,
          data: { type: 'nuevo_pedido', pedidoId: result.id, cliente: cliente || '', total: totalNumeroGlobal.toString(), whatsapp }
        });
      } catch (e) { console.log('⚠️ Error push notification:', e.message); }

      console.log(`✅ Pedido Supabase: ${result.id} - ${result.estado}`);
      return res.status(201).json({
        success: true, mensaje: 'Pedido creado',
        pedido: {
          ...result,
          productos: productosDetalle.map(p => `${p.cantidad}x ${p.nombre} - S/${(p.precio * p.cantidad).toFixed(2)}`).join(', '),
          productosDetalle,
          costoEnvio: costoEnvioGlobal,
          subtotal: totalNumeroGlobal - costoEnvioGlobal
        }
      });
    }

    const sheets = await getSheetsService(negocio);

    const pedidoId = `PED-${Date.now().toString().slice(-8)}`;
    const { fecha: fechaPeru, hora: horaPeru } = getPeruDateTime();

    let productosStr = '';
    if (Array.isArray(productos)) {
      productosStr = productos.map(p => `${p.cantidad}x ${p.nombre} - S/${(p.precio * p.cantidad).toFixed(2)}`).join(', ');
    } else {
      productosStr = productos;
    }

    const estadoFinal = estado || 'EN_PREPARACION';
    const origenFinal = origen || 'APP';
    const totalNumero = parseDecimal(total);
    const costoEnvioNumero = parseDecimal(costoEnvio);

    const valores = [
      pedidoId, fechaPeru, horaPeru, (whatsapp || '').toString().replace(/[^0-9]/g, ''),
      cliente || '', telefono || '', direccion || '', productosStr, totalNumero, estadoFinal,
      '', observaciones || '', tipoEnvio || '', empresaEnvio || '', origenFinal
    ];

    await sheets.appendRow('Pedidos', valores);

    // Notificar al cliente por WhatsApp
    if (notificarCliente && whatsapp !== '000000000') {
      try {
        const whatsappService = new WhatsAppService(negocio.whatsapp);
        const mensaje = `✅ *Pedido Registrado*\n\n📦 Pedido: *${pedidoId}*\n💰 Total: *S/ ${totalNumero.toFixed(2)}*\n📝 Productos: ${productosStr}\n\n¡Gracias por tu compra!`;
        await whatsappService.sendMessage(whatsapp, mensaje);
      } catch (e) { console.log('⚠️ Error notificando al cliente:', e.message); }
    }

    // 🔔 Enviar push notification al negocio
    try {
      await firebaseService.initialize();
      await firebaseService.enviarNotificacion(businessId, {
        title: '🛒 Nuevo Pedido',
        body: `${cliente || 'Cliente'} - S/ ${totalNumero.toFixed(2)}`,
        data: {
          type: 'nuevo_pedido',
          pedidoId: pedidoId,
          cliente: cliente || '',
          total: totalNumero.toString(),
          whatsapp: whatsapp
        }
      });
      console.log(`🔔 Push notification enviada para pedido ${pedidoId}`);
    } catch (e) {
      console.log('⚠️ Error enviando push notification:', e.message);
    }

    // 🚚 Notificar al negocio delivery si aplica (fire-and-forget)
    deliveryService.notificarNuevoDelivery(
      { id: pedidoId, whatsapp: (whatsapp || '').replace(/[^0-9]/g, ''), cliente: cliente || '', telefono: telefono || '', direccion: direccion || '', productos: productosStr, total: totalNumero },
      negocio,
      negociosService
    ).catch(e => console.error('⚠️ [Delivery] Error en hook API:', e.message));

    console.log(`✅ Pedido creado: ${pedidoId} - ${estadoFinal} - ${origenFinal}`);
    res.status(201).json({ success: true, mensaje: 'Pedido creado', pedido: { id: pedidoId, fecha: fechaPeru, hora: horaPeru, whatsapp, cliente, productos: productosStr, total: totalNumero, costoEnvio: costoEnvioNumero, subtotal: totalNumero - costoEnvioNumero, estado: estadoFinal, origen: origenFinal } });
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/pedidos/:businessId/:pedidoId/items', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { presentacionId, codigo, cantidad, grind } = req.body;
    if (!cantidad || cantidad < 1) return res.status(400).json({ error: 'cantidad requerida' });
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (!negocio.plataformaExterna) return res.status(400).json({ error: 'Solo disponible para pedidos Supabase' });
    const result = await supabaseService.updateOrderItem(pedidoId, { presentacionId, codigo, cantidad, grind });
    console.log(`[Items] pedido=${pedidoId} cantidad=${cantidad} grind=${grind} → subtotal=${result.subtotal}`);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[Items] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/pedidos/:businessId/:pedidoId/shipping', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { costoEnvio } = req.body;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (!negocio.plataformaExterna) return res.status(400).json({ error: 'Solo disponible para pedidos Supabase' });
    const shippingCents = Math.round((parseFloat(costoEnvio) || 0) * 100);
    await supabaseService.updateOrderShipping(pedidoId, shippingCents);
    console.log(`[Shipping] pedido=${pedidoId} costoEnvio=${costoEnvio}`);
    res.json({ success: true, costoEnvio: shippingCents / 100 });
  } catch (error) {
    console.error('[Shipping] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.put('/pedidos/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { estado, observaciones, notificarCliente } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Pedidos!A:L');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const updates = [];
        if (estado) updates.push({ range: `Pedidos!J${i + 1}`, value: estado });
        if (observaciones) updates.push({ range: `Pedidos!L${i + 1}`, value: observaciones });
        if (updates.length > 0) await sheets.batchUpdate(updates);

        if (notificarCliente && estado) {
          try {
            const whatsapp = new WhatsAppService(negocio.whatsapp);
            const clienteWhatsapp = rows[i][3];
            const mensajesEstado = {
              'CONFIRMADO': `✅ Tu pedido *${pedidoId}* ha sido confirmado.`,
              'EN_PREPARACION': `📦 Tu pedido *${pedidoId}* está en preparación.`,
              'ENVIADO': `🚚 Tu pedido *${pedidoId}* ha sido enviado.`,
              'ENTREGADO': `✅ Tu pedido *${pedidoId}* ha sido entregado.`,
              'CANCELADO': `❌ Tu pedido *${pedidoId}* ha sido cancelado.`
            };
            const mensaje = mensajesEstado[estado];
            if (mensaje) await whatsapp.sendMessage(clienteWhatsapp, mensaje);
          } catch (e) { console.log('⚠️ Error notificando:', e.message); }
        }

        return res.json({ success: true, pedidoId, nuevoEstado: estado });
      }
    }
    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /pedidos/:businessId/:pedidoId/pagos/:pagoId
router.delete('/pedidos/:businessId/:pedidoId/pagos/:pagoId', async (req, res) => {
  try {
    const { businessId, pedidoId, pagoId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna && negocio.farmId) {
      const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

      // Eliminar el pago (y sus comprobantes en cascada); recalcula payment_status internamente
      await supabaseService.deleteOrderPayment(pagoId, pedido.supabaseId);

      // Devolver orden actualizada para que el cliente refresque estado sin extra-fetch
      const updated = await supabaseService.getOrderByIdOrNumber(pedidoId);
      return res.json({
        success: true,
        estadoPago:   updated.estadoPago,
        montoPagado:  updated.montoPagado,
        pagos:        updated.pagos,
        evidencias:   updated.evidencias,
      });
    }

    res.status(400).json({ error: 'Operación no soportada para este negocio' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CLIENTES
router.get('/clientes/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, departamento, ordenar } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    console.log(`[Clientes GET] businessId=${businessId} plataformaExterna=${negocio.plataformaExterna} farmId=${negocio.farmId}`);

    if (negocio.plataformaExterna && negocio.farmId) {
      console.log(`[Clientes GET] → rama Supabase activada, llamando getAllCustomers...`);
      const profiles = await supabaseService.getAllCustomers({ search: buscar });
      console.log(`[Clientes GET] → ${profiles.length} perfiles obtenidos de Supabase`);
      const clientes = profiles.map(p => ({
        id:            p.id,
        whatsapp:      p.phone || '',
        nombre:        p.full_name || '',
        telefono:      p.phone || '',
        email:         p.email || '',
        fechaRegistro: p.created_at ? new Date(p.created_at).toLocaleDateString('es-PE') : '',
        ultimaCompra:  '',
        departamento:  '',
        ciudad:        '',
        empresa:       '',
        notas:         ''
      }));
      if (ordenar === 'nombre') clientes.sort((a, b) => a.nombre.localeCompare(b.nombre));
      return res.json({ total: clientes.length, clientes });
    }

    // Default: read from sheet
    const sheets = await getSheetsServiceDirect(negocio);
    const rows = await sheets.getRows('Clientes!A:K');

    let clientes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;
      const cliente = {
        id: row[0] || '', whatsapp: row[1] || '', nombre: row[2] || '', telefono: row[3] || '',
        direccion: row[4] || '', fechaRegistro: row[5] || '', ultimaCompra: row[6] || '',
        departamento: row[7] || '', ciudad: row[8] || '', empresa: row[9] || '', notas: row[10] || ''
      };
      if (buscar) {
        const s = buscar.toLowerCase();
        if (!cliente.nombre.toLowerCase().includes(s) && !cliente.whatsapp.includes(buscar) && !cliente.empresa.toLowerCase().includes(s) && !cliente.telefono.includes(buscar)) continue;
      }
      if (departamento && cliente.departamento !== departamento) continue;
      clientes.push(cliente);
    }
    if (ordenar === 'nombre') clientes.sort((a, b) => a.nombre.localeCompare(b.nombre));
    else if (ordenar === 'reciente') clientes.sort((a, b) => new Date(b.fechaRegistro) - new Date(a.fechaRegistro));
    else if (ordenar === 'ultima_compra') clientes.sort((a, b) => new Date(b.ultimaCompra) - new Date(a.ultimaCompra));

    res.json({ total: clientes.length, clientes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/clientes/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    if (negocio.plataformaExterna && negocio.farmId && isUUID(clienteId)) {
      const [profile, sheetRows] = await Promise.all([
        supabaseService.getCustomerById(clienteId),
        sheets.getRows('Clientes!A:K')
      ]);
      if (!profile) return res.status(404).json({ error: 'Cliente no encontrado' });

      const sheetRow = sheetRows.slice(1).find(r => (r[0] || '').trim() === clienteId) || [];
      const cliente = {
        id:            profile.id,
        whatsapp:      profile.phone  || '',
        nombre:        profile.full_name || '',
        telefono:      profile.phone  || '',
        email:         profile.email  || '',
        direccion:     '',
        fechaRegistro: sheetRow[5]  || '',
        ultimaCompra:  sheetRow[6]  || '',
        departamento:  sheetRow[7]  || '',
        ciudad:        sheetRow[8]  || '',
        empresa:       sheetRow[9]  || '',
        notas:         sheetRow[10] || ''
      };

      const pedidos = await sheets.getPedidosByWhatsapp(profile.phone || '');
      return res.json({
        cliente, pedidos: pedidos.slice(0, 20),
        estadisticas: { totalPedidos: pedidos.length, totalComprado: pedidos.reduce((sum, p) => sum + p.total, 0), pedidosActivos: pedidos.filter(p => !['ENTREGADO', 'CANCELADO'].includes(p.estado)).length }
      });
    }

    // Default: read from sheet
    const rows = await sheets.getRows('Clientes!A:K');
    let cliente = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        cliente = {
          id: rows[i][0], whatsapp: rows[i][1] || '', nombre: rows[i][2] || '', telefono: rows[i][3] || '',
          direccion: rows[i][4] || '', fechaRegistro: rows[i][5] || '', ultimaCompra: rows[i][6] || '',
          departamento: rows[i][7] || '', ciudad: rows[i][8] || '', empresa: rows[i][9] || '', notas: rows[i][10] || ''
        };
        break;
      }
    }
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const pedidos = await sheets.getPedidosByWhatsapp(cliente.whatsapp);
    res.json({
      cliente, pedidos: pedidos.slice(0, 20),
      estadisticas: { totalPedidos: pedidos.length, totalComprado: pedidos.reduce((sum, p) => sum + p.total, 0), pedidosActivos: pedidos.filter(p => !['ENTREGADO', 'CANCELADO'].includes(p.estado)).length }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/clientes/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { whatsapp, nombre, telefono, direccion, departamento, ciudad, empresa, notas, email } = req.body;
    if (!whatsapp || !nombre) return res.status(400).json({ error: 'Campos requeridos: whatsapp, nombre' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);
    const phone = whatsapp.replace(/[^0-9]/g, '');
    const fechaHoy = formatPeruDate();

    if (negocio.plataformaExterna && negocio.farmId) {
      // Check duplicate in Supabase
      const existente = await supabaseService.getCustomerByPhone(phone);
      if (existente) return res.status(400).json({ error: 'Ya existe un cliente con ese WhatsApp', clienteExistente: existente.id });

      let nuevo;
      try {
        nuevo = await supabaseService.createCustomer({ fullName: nombre, phone, email: email || null });
      } catch (e) {
        if (e.code === 'duplicate_phone') return res.status(400).json({ error: e.message });
        throw e;
      }
      if (!nuevo) return res.status(500).json({ error: 'Error creando cliente en Supabase' });

      // Register UUID in sheet col A only
      try { await sheets.appendRow('Clientes', [nuevo.id, phone, nombre, '', '', fechaHoy, '', '', '', '', '']); } catch (e) {}

      return res.status(201).json({ success: true, mensaje: 'Cliente creado', cliente: { id: nuevo.id, whatsapp: phone, nombre, email: nuevo.email || '', fechaRegistro: fechaHoy } });
    }

    // Default: sheet only
    const sheetRows = await sheets.getRows('Clientes!A:B');
    const dup = sheetRows.slice(1).find(r => (r[1] || '').replace(/[^0-9]/g, '') === phone);
    if (dup) return res.status(400).json({ error: 'Ya existe un cliente con ese WhatsApp', clienteExistente: dup[0] });

    const clienteId = `CLI-${Date.now().toString().slice(-6)}`;
    await sheets.appendRow('Clientes', [clienteId, phone, nombre, telefono || '', direccion || '', fechaHoy, '', departamento || '', ciudad || '', empresa || '', notas || '']);
    res.status(201).json({ success: true, mensaje: 'Cliente creado', cliente: { id: clienteId, whatsapp: phone, nombre, telefono: telefono || '', direccion: direccion || '', fechaRegistro: fechaHoy, departamento: departamento || '', ciudad: ciudad || '', empresa: empresa || '', notas: notas || '' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/clientes/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { nombre, telefono, direccion, departamento, ciudad, empresa, notas, whatsapp } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    if (negocio.plataformaExterna && negocio.farmId && isUUID(clienteId)) {
      // Update Supabase for core fields
      const supabaseUpdates = {};
      if (nombre !== undefined)   supabaseUpdates.full_name = nombre;
      if (whatsapp !== undefined)  supabaseUpdates.phone = whatsapp.replace(/[^0-9]/g, '');
      if (Object.keys(supabaseUpdates).length > 0)
        await supabaseService.updateCustomer(clienteId, supabaseUpdates).catch(e =>
          console.warn('[Supabase] updateCustomer error:', e.message)
        );

      // Update extra fields in sheet
      const sheetRows = await sheets.getRows('Clientes!A:K');
      for (let i = 1; i < sheetRows.length; i++) {
        if ((sheetRows[i][0] || '').trim() === clienteId) {
          const updates = [];
          if (departamento !== undefined) updates.push({ range: `Clientes!H${i + 1}`, value: departamento });
          if (ciudad !== undefined)       updates.push({ range: `Clientes!I${i + 1}`, value: ciudad });
          if (empresa !== undefined)      updates.push({ range: `Clientes!J${i + 1}`, value: empresa });
          if (notas !== undefined)        updates.push({ range: `Clientes!K${i + 1}`, value: notas });
          if (updates.length > 0) await sheets.batchUpdate(updates);
          break;
        }
      }
      return res.json({ success: true, mensaje: 'Cliente actualizado', clienteId });
    }

    // Default: sheet only
    const rows = await sheets.getRows('Clientes!A:K');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        const updates = [];
        if (whatsapp !== undefined)     updates.push({ range: `Clientes!B${i + 1}`, value: whatsapp.replace(/[^0-9]/g, '') });
        if (nombre !== undefined)       updates.push({ range: `Clientes!C${i + 1}`, value: nombre });
        if (telefono !== undefined)     updates.push({ range: `Clientes!D${i + 1}`, value: telefono });
        if (direccion !== undefined)    updates.push({ range: `Clientes!E${i + 1}`, value: direccion });
        if (departamento !== undefined) updates.push({ range: `Clientes!H${i + 1}`, value: departamento });
        if (ciudad !== undefined)       updates.push({ range: `Clientes!I${i + 1}`, value: ciudad });
        if (empresa !== undefined)      updates.push({ range: `Clientes!J${i + 1}`, value: empresa });
        if (notas !== undefined)        updates.push({ range: `Clientes!K${i + 1}`, value: notas });
        if (updates.length > 0) await sheets.batchUpdate(updates);
        return res.json({ success: true, mensaje: 'Cliente actualizado', clienteId });
      }
    }
    res.status(404).json({ error: 'Cliente no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/clientes/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Clientes!A:B');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        await sheets.updateCell(`Clientes!A${i + 1}`, `${clienteId}_DELETED_${Date.now()}`);
        return res.json({ success: true, mensaje: 'Cliente eliminado', clienteId });
      }
    }
    res.status(404).json({ error: 'Cliente no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/clientes/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { clientes } = req.body;
    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) return res.status(400).json({ error: 'Se requiere array de clientes' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);

    const resultados = { creados: [], existentes: [], errores: [] };

    for (const cli of clientes) {
      try {
        if (!cli.whatsapp || !cli.nombre) { resultados.errores.push({ whatsapp: cli.whatsapp, error: 'Falta whatsapp o nombre' }); continue; }
        const whatsappLimpio = cli.whatsapp.replace(/[^0-9]/g, '');
        const existente = await sheets.buscarCliente(whatsappLimpio);
        if (existente) { resultados.existentes.push(whatsappLimpio); continue; }

        const clienteId = `CLI-${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(-2)}`;
        await sheets.appendRow('Clientes', [clienteId, whatsappLimpio, cli.nombre, cli.telefono || '', cli.direccion || '', formatPeruDate(), '', cli.departamento || '', cli.ciudad || '', cli.empresa || '', cli.notas || '']);
        resultados.creados.push(whatsappLimpio);
      } catch (e) { resultados.errores.push({ whatsapp: cli.whatsapp, error: e.message }); }
    }

    res.json({ success: true, resumen: { total: clientes.length, creados: resultados.creados.length, existentes: resultados.existentes.length, errores: resultados.errores.length }, detalles: resultados });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/clientes/:businessId/:clienteId/mensaje', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ error: 'Campo requerido: mensaje' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Clientes!A:B');
    let whatsappCliente = null;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) { whatsappCliente = rows[i][1]; break; }
    }
    if (!whatsappCliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendMessage(whatsappCliente, mensaje);
    res.json({ success: true, messageId: result.messages?.[0]?.id, to: whatsappCliente });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PRECIOS CLIENTE
router.get('/precios-cliente/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      const rows = await supabaseService.getCustomerPrices(clienteId);
      const precios = {};
      for (const r of rows) {
        precios[r.presentation_id] = {
          precio: r.price_cents / 100,
          fechaActualizacion: r.updated_at ? new Date(r.updated_at).toLocaleDateString('es-PE') : '',
          actualizadoPor: r.updated_by || 'APP'
        };
      }
      return res.json({ clienteId, precios, total: Object.keys(precios).length });
    }

    const sheets = await getSheetsService(negocio);
    let rows = [];
    try { rows = await sheets.getRows('PreciosClientes!A:E'); } catch (e) { return res.json({ clienteId, precios: {}, total: 0 }); }
    const precios = {};
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] === clienteId && row[1] && row[2]) {
        precios[row[1]] = { precio: parseDecimal(row[2]), fechaActualizacion: row[3] || '', actualizadoPor: row[4] || '' };
      }
    }
    res.json({ clienteId, precios, total: Object.keys(precios).length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/precios-cliente/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { precios, usuario } = req.body;
    console.log(`[precios-cliente POST] businessId=${businessId} clienteId=${clienteId} precios=${JSON.stringify(precios)} usuario=${usuario}`);
    if (!precios || typeof precios !== 'object') return res.status(400).json({ error: 'Campo requerido: precios' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      const saved = await supabaseService.upsertCustomerPrices(clienteId, precios, usuario || 'APP');
      console.log(`[precios-cliente POST] OK clienteId=${clienteId} saved=${saved.length}`);
      return res.json({ success: true, mensaje: 'Precios guardados', clienteId, resumen: { total: saved.length } });
    }

    const sheets = await getSheetsService(negocio);
    const fechaHoy = formatPeruDate();
    const usuarioFinal = usuario || 'APP';
    let rows = [];
    try { rows = await sheets.getRows('PreciosClientes!A:E'); } catch (e) { rows = [['clienteId', 'codigoProducto', 'precioPersonalizado', 'fechaActualizacion', 'actualizadoPor']]; }

    const filasExistentes = {};
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId && rows[i][1]) filasExistentes[rows[i][1]] = i + 1;
    }

    const updates = [];
    const nuevosRegistros = [];
    let actualizados = 0, creados = 0;

    for (const [codigoProducto, precio] of Object.entries(precios)) {
      const precioNumero = parseDecimal(precio);
      if (filasExistentes[codigoProducto]) {
        const rowNum = filasExistentes[codigoProducto];
        updates.push({ range: `PreciosClientes!C${rowNum}`, value: precioNumero });
        updates.push({ range: `PreciosClientes!D${rowNum}`, value: fechaHoy });
        updates.push({ range: `PreciosClientes!E${rowNum}`, value: usuarioFinal });
        actualizados++;
      } else {
        nuevosRegistros.push([clienteId, codigoProducto, precioNumero, fechaHoy, usuarioFinal]);
        creados++;
      }
    }

    if (updates.length > 0) await sheets.batchUpdate(updates);
    for (const registro of nuevosRegistros) await sheets.appendRow('PreciosClientes', registro);
    res.json({ success: true, mensaje: 'Precios guardados', clienteId, resumen: { actualizados, creados, total: actualizados + creados } });
  } catch (error) {
    console.error('[precios-cliente POST] error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/precios-cliente/:businessId/:clienteId/:presentationId', async (req, res) => {
  try {
    const { businessId, clienteId, presentationId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      await supabaseService.deleteCustomerPrice(clienteId, presentationId);
      return res.json({ success: true, mensaje: 'Precio eliminado', clienteId, presentationId });
    }

    const sheets = await getSheetsService(negocio);
    let rows = [];
    try { rows = await sheets.getRows('PreciosClientes!A:E'); } catch (e) { return res.status(404).json({ error: 'Precio no encontrado' }); }

    let rowToDelete = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId && rows[i][1] === presentationId) { rowToDelete = i + 1; break; }
    }
    if (!rowToDelete) return res.status(404).json({ error: 'Precio personalizado no encontrado' });

    const ok = await sheets.deleteSheetRow('PreciosClientes', rowToDelete);
    if (ok) res.json({ success: true, mensaje: 'Precio eliminado', clienteId, presentationId });
    else res.status(500).json({ error: 'Error eliminando fila' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NEGOCIOS
router.get('/negocios', (req, res) => {
  const negocios = negociosService.getAll().map(n => ({ id: n.id, nombre: n.nombre, tipo: n.whatsapp.tipo, flujo: n.flujo, features: n.features }));
  res.json(negocios);
});

router.get('/negocios/por-whatsapp/:whatsapp', async (req, res) => {
  try {
    let { whatsapp } = req.params;
    whatsapp = whatsapp.replace(/[^0-9]/g, '');
    if (whatsapp.length === 9) whatsapp = '51' + whatsapp;

    // Supabase-based admin auth
    const adminData = await supabaseService.getAdminFarmsByPhone(whatsapp);

    if (!adminData) {
      return res.json({ encontrado: false, mensaje: 'Número no registrado como administrador' });
    }
    if (!adminData.authorized) {
      return res.json({ encontrado: false, mensaje: 'No tienes permisos de administrador en ningún negocio' });
    }

    // Map farms → negocios config
    const negociosMapeados = [];
    for (const farm of adminData.farms) {
      const negocio = negociosService.getAll().find(n => n.farmId === farm.id);
      if (negocio) {
        negociosMapeados.push({
          id:        negocio.id,
          nombre:    negocio.nombre || farm.name,
          farmId:    farm.id,
          slug:      farm.slug,
          flujo:     negocio.flujo,
          features:  negocio.features,
          direccion: negocio.direccion || '',
          ciudad:    negocio.ciudad || farm.city || '',
        });
      }
    }

    if (negociosMapeados.length === 0) {
      return res.json({ encontrado: false, mensaje: 'No se encontró configuración activa para tu negocio' });
    }

    if (negociosMapeados.length === 1) {
      return res.json({ encontrado: true, negocio: negociosMapeados[0] });
    }

    return res.json({ encontrado: true, negocios: negociosMapeados });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ONE-TIME: Setup admin user — delete after use
router.post('/setup/admin', async (req, res) => {
  const { secret, phone, fullName, farmId } = req.body;
  if (secret !== process.env.ADMIN_SETUP_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const axios = require('axios');
    const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const cleaned = phone.replace(/\D/g, '');
    const email = `${cleaned}@admin.apartalo.co`;

    // 1. Fix the conflicting customer phone (Angie Cruz had Keyla's number)
    await axios.patch(
      `${baseUrl}/rest/v1/profiles?phone=eq.${cleaned}`,
      { phone: '51922636789' },
      { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' } }
    );

    // 2. Create auth user for the new admin
    let userId;
    try {
      const { data: authUser } = await axios.post(`${baseUrl}/auth/v1/admin/users`, {
        email,
        email_confirm: true,
        phone: cleaned,
        phone_confirm: true,
        user_metadata: { full_name: fullName || 'Admin' },
        email_change: '',
        email_change_token_new: '',
        email_change_token_current: '',
      }, { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
      userId = authUser.id;
    } catch (e) {
      if (e.response?.data?.error_code === 'email_exists') {
        // Already exists — look up by phone in profiles
        const { data: existing } = await axios.get(
          `${baseUrl}/rest/v1/profiles?phone=eq.${cleaned}&select=id`,
          { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        userId = existing?.[0]?.id;
      } else throw e;
    }
    if (!userId) return res.status(500).json({ error: 'No se pudo obtener el userId' });

    // 3. Update profile: role=admin, full_name
    await axios.patch(
      `${baseUrl}/rest/v1/profiles?id=eq.${userId}`,
      { role: 'admin', full_name: fullName || 'Admin', phone: cleaned },
      { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' } }
    );

    // 4. Add to farm_members as admin
    const targetFarmId = farmId || 'c1d391b2-31d0-4eb4-a3e5-6986490e4dd3';
    await axios.post(
      `${baseUrl}/rest/v1/farm_members`,
      { farm_id: targetFarmId, user_id: userId, role: 'admin' },
      { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' } }
    );

    res.json({ success: true, userId, email, message: `Admin creado: ${fullName} (${cleaned})` });
  } catch (error) {
    console.error('[setup/admin] Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.msg || error.message });
  }
});

router.post('/negocios/reload', async (req, res) => {
  try {
    await negociosService.reload();
    res.json({ success: true, count: negociosService.getAll().length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DEBUG: Ver configExtra de un negocio en memoria
router.get('/debug/negocio/:businessId', (req, res) => {
  const negocio = negociosService.getById(req.params.businessId);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  res.json({ id: negocio.id, nombre: negocio.nombre, configExtra: negocio.configExtra });
});

// PRODUCTOS
router.get('/productos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, buscar, ordenar, pagina = 1, limite = 20 } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);

    let productos = await sheets.getProductos(estado || null);

    if (buscar) {
      const s = buscar.toLowerCase();
      productos = productos.filter(p => p.nombre.toLowerCase().includes(s) || p.codigo.toLowerCase().includes(s) || (p.descripcion || '').toLowerCase().includes(s));
    }

    productos.reverse();

    if (ordenar === 'precio_asc') productos.sort((a, b) => a.precio - b.precio);
    else if (ordenar === 'precio_desc') productos.sort((a, b) => b.precio - a.precio);
    else if (ordenar === 'stock') productos.sort((a, b) => b.disponible - a.disponible);
    else if (ordenar === 'nombre') productos.sort((a, b) => a.nombre.localeCompare(b.nombre));
    else if (negocio.farmId) {
      // Default: sort by best seller + merge images and presentations from Supabase
      try {
        const supabaseProducts = await supabaseService.getProductsWithPresentations(negocio.farmId);
        const byName = {};
        for (const sp of supabaseProducts) byName[sp.name.toLowerCase()] = sp;
        // Merge image_url and presentations into Sheets products
        productos = productos.map(p => {
          const sp = byName[(p.nombre || '').toLowerCase()];
          if (!sp) return p;
          return {
            ...p,
            imagenUrl: p.imagenUrl || sp.image_url || '',
            presentaciones: sp.presentations.map(pp => ({
              id:           pp.id,
              contenido:    pp.pack_size,
              unidad:       pp.unit,
              precio:       pp.price_cents / 100,
              precioB2b:    pp.b2b_price_cents ? pp.b2b_price_cents / 100 : null,
              cantidadB2b:  pp.min_qty_for_b2b || null,
              stock:        pp.stock || 0,
              pedidoMinimo: pp.min_order_qty || 1,
              orden:        pp.sort_order || 0,
              predeterminada: pp.is_default || false,
              molienda:     pp.grind || [],
              imageUrl:     pp.image_url || null
            })),
            _totalSold: sp.totalSold || 0
          };
        });
        productos.sort((a, b) => {
          const sa = a._totalSold || 0;
          const sb = b._totalSold || 0;
          return sb - sa || (a.nombre || '').localeCompare(b.nombre || '');
        });
        productos = productos.map(({ _totalSold, ...rest }) => rest);
      } catch (e) { /* keep original order on error */ }
    }

    const total = productos.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 20;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;

    res.json({ total, pagina: paginaNum, limite: limiteNum, totalPaginas, hayMas: paginaNum < totalPaginas, productos: productos.slice(inicio, inicio + limiteNum) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const productos = await sheets.getProductos();
    const producto = productos.find(p => p.codigo === codigo);
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(producto);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Campo requerido: nombre' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const supabase = require('../core/services/supabase-service');
    const created = await supabase.createProduct(negocio.farmId, { name: nombre, status: 'draft' });
    if (!created) return res.status(500).json({ error: 'No se pudo crear el producto' });

    res.status(201).json({ success: true, mensaje: 'Producto creado', producto: { codigo: created.id, nombre: created.name, estado: 'BORRADOR', presentaciones: [] } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { nombre, descripcion, precio, stock, imagenUrl, estado, categoria, proveedorId, proveedorProductoCodigo, precioMayor, cantidadMayor } = req.body;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Inventario!A:M');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === codigo) {
        const updates = [];
        if (nombre !== undefined) updates.push({ range: `Inventario!B${i + 1}`, value: nombre });
        if (descripcion !== undefined) updates.push({ range: `Inventario!C${i + 1}`, value: descripcion });
        if (precio !== undefined) updates.push({ range: `Inventario!D${i + 1}`, value: parseDecimal(precio) });
        if (stock !== undefined) updates.push({ range: `Inventario!E${i + 1}`, value: parseInt(stock) || 0 });
        if (imagenUrl !== undefined) updates.push({ range: `Inventario!G${i + 1}`, value: imagenUrl });
        if (estado !== undefined) updates.push({ range: `Inventario!H${i + 1}`, value: estado });
        if (categoria !== undefined) updates.push({ range: `Inventario!I${i + 1}`, value: categoria });
        if (proveedorId !== undefined) updates.push({ range: `Inventario!J${i + 1}`, value: proveedorId });
        if (proveedorProductoCodigo !== undefined) updates.push({ range: `Inventario!K${i + 1}`, value: proveedorProductoCodigo });
        if (precioMayor !== undefined) updates.push({ range: `Inventario!L${i + 1}`, value: parseDecimal(precioMayor) });
        if (cantidadMayor !== undefined) updates.push({ range: `Inventario!N${i + 1}`, value: parseFloat(cantidadMayor) || null });
        if (updates.length > 0) await sheets.batchUpdate(updates);

        const productosActualizados = await sheets.getProductos();
        return res.json({ success: true, mensaje: 'Producto actualizado', producto: productosActualizados.find(p => p.codigo === codigo) });
      }
    }
    res.status(404).json({ error: 'Producto no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { force } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Inventario!A:H');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === codigo) {
        if (force === 'true') {
          await sheets.updateCell(`Inventario!H${i + 1}`, 'ELIMINADO');
          await sheets.updateCell(`Inventario!A${i + 1}`, `${codigo}_DELETED_${Date.now()}`);
        } else {
          await sheets.updateCell(`Inventario!H${i + 1}`, 'INACTIVO');
        }
        return res.json({ success: true, mensaje: force === 'true' ? 'Producto eliminado' : 'Producto desactivado', codigo });
      }
    }
    res.status(404).json({ error: 'Producto no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId/:codigo/stock', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { cantidad, operacion, motivo } = req.body;
    if (cantidad === undefined || !operacion) return res.status(400).json({ error: 'Campos requeridos: cantidad, operacion' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);
    const rows = await sheets.getRows('Inventario!A:F');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === codigo) {
        const stockActual = parseInt(rows[i][4]) || 0;
        let nuevoStock;
        if (operacion === 'agregar') nuevoStock = stockActual + parseInt(cantidad);
        else if (operacion === 'restar') nuevoStock = Math.max(0, stockActual - parseInt(cantidad));
        else if (operacion === 'establecer') nuevoStock = parseInt(cantidad);
        else return res.status(400).json({ error: 'Operación inválida' });

        await sheets.updateCell(`Inventario!E${i + 1}`, nuevoStock);
        try { await sheets.appendRow('MovimientosStock', [`MOV-${Date.now()}`, new Date().toISOString(), codigo, rows[i][1], operacion, cantidad, stockActual, nuevoStock, motivo || '']); } catch (e) {}

        return res.json({ success: true, codigo, stockAnterior: stockActual, stockNuevo: nuevoStock, operacion, cantidad: parseInt(cantidad) });
      }
    }
    res.status(404).json({ error: 'Producto no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { productos } = req.body;
    if (!productos || !Array.isArray(productos) || productos.length === 0) return res.status(400).json({ error: 'Se requiere array de productos' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsService(negocio);

    const existentes = await sheets.getProductos();
    const codigosExistentes = new Set(existentes.map(p => p.codigo));
    const resultados = { creados: [], actualizados: [], errores: [] };

    for (const prod of productos) {
      try {
        if (!prod.codigo || !prod.nombre) { resultados.errores.push({ codigo: prod.codigo, error: 'Falta codigo o nombre' }); continue; }

        if (codigosExistentes.has(prod.codigo)) {
          const rows = await sheets.getRows('Inventario!A:I');
          for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === prod.codigo) {
              const updates = [];
              if (prod.nombre) updates.push({ range: `Inventario!B${i + 1}`, value: prod.nombre });
              if (prod.precio !== undefined) updates.push({ range: `Inventario!D${i + 1}`, value: parseDecimal(prod.precio) });
              if (prod.stock !== undefined) updates.push({ range: `Inventario!E${i + 1}`, value: parseInt(prod.stock) || 0 });
              if (updates.length > 0) await sheets.batchUpdate(updates);
              break;
            }
          }
          resultados.actualizados.push(prod.codigo);
        } else {
          await sheets.appendRow('Inventario', [prod.codigo, prod.nombre, prod.descripcion || '', parseDecimal(prod.precio), parseInt(prod.stock) || 0, 0, prod.imagenUrl || '', prod.estado || 'ACTIVO', prod.categoria || '']);
          resultados.creados.push(prod.codigo);
          codigosExistentes.add(prod.codigo);
        }
      } catch (e) { resultados.errores.push({ codigo: prod.codigo, error: e.message }); }
    }

    res.json({ success: true, resumen: { total: productos.length, creados: resultados.creados.length, actualizados: resultados.actualizados.length, errores: resultados.errores.length }, detalles: resultados });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// RECETAS (Production Recipes)
// ─── PRESENTACIONES ──────────────────────────────────────────────────────────

router.get('/productos/:businessId/:productId/presentaciones', async (req, res) => {
  try {
    const { businessId, productId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const supabaseService = require('../core/services/supabase-service');
    const presentations = await supabaseService.getPresentations(productId);

    // Derive stock from FIFO lot pool (same logic as getProductsWithPresentations)
    let availableKg = null;
    try {
      availableKg = await supabaseService.getProductAvailableKg(productId);
    } catch (_) { /* non-fatal — fall back to pp.stock */ }

    res.json({ availableKg, presentaciones: presentations.map(pp => {
      let stock = pp.stock || 0;
      if (availableKg !== null) {
        const kgPerUnit = pp.unit === 'kg' ? Number(pp.pack_size) :
                          pp.unit === 'g'  ? Number(pp.pack_size) / 1000 : 0;
        stock = kgPerUnit > 0 ? Math.max(0, Math.floor(availableKg / kgPerUnit)) : 0;
      }
      return {
        id:           pp.id,
        contenido:    pp.pack_size,
        unidad:       pp.unit,
        precio:       pp.price_cents / 100,
        precioB2b:    pp.b2b_price_cents ? pp.b2b_price_cents / 100 : null,
        cantidadB2b:  pp.min_qty_for_b2b || null,
        stock,
        pedidoMinimo: pp.min_order_qty || 1,
        orden:        pp.sort_order || 0,
        predeterminada: pp.is_default || false,
        molienda:     pp.grind || [],
        imageUrl:     pp.image_url || null
      };
    }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId/:productId/presentaciones', async (req, res) => {
  try {
    const { businessId, productId } = req.params;
    const { contenido, unidad, precio, precioB2b, cantidadB2b, stock, pedidoMinimo, orden, predeterminada, molienda } = req.body;
    if (contenido === undefined || !unidad || precio === undefined) {
      return res.status(400).json({ error: 'Campos requeridos: contenido, unidad, precio' });
    }
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const supabaseService = require('../core/services/supabase-service');

    if (predeterminada) {
      const existing = await supabaseService.getPresentations(productId);
      await Promise.all(existing.filter(pp => pp.is_default).map(pp => supabaseService.updatePresentation(pp.id, { is_default: false })));
    }

    const created = await supabaseService.createPresentation(productId, {
      packSize:     parseFloat(contenido),
      unit:         unidad,
      priceCents:   Math.round(parseFloat(precio) * 100),
      b2bPriceCents: precioB2b != null ? Math.round(parseFloat(precioB2b) * 100) : null,
      minQtyForB2b: cantidadB2b != null ? parseInt(cantidadB2b) : null,
      stock:        parseFloat(stock) || 0,
      minOrderQty:  parseFloat(pedidoMinimo) || 1,
      sortOrder:    parseInt(orden) || 0,
      isDefault:    predeterminada || false,
      grind:        Array.isArray(molienda) ? molienda : []
    });
    if (!created) return res.status(500).json({ error: 'No se pudo crear la presentación' });

    res.status(201).json({ success: true, mensaje: 'Presentación creada', presentacion: { id: created.id } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/productos/:businessId/:productId/presentaciones/:presentationId', async (req, res) => {
  try {
    const { businessId, productId, presentationId } = req.params;
    const { contenido, unidad, precio, precioB2b, cantidadB2b, stock, pedidoMinimo, orden, predeterminada, molienda } = req.body;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const supabaseService = require('../core/services/supabase-service');

    if (predeterminada) {
      const existing = await supabaseService.getPresentations(productId);
      await Promise.all(
        existing.filter(pp => pp.is_default && pp.id !== presentationId)
          .map(pp => supabaseService.updatePresentation(pp.id, { is_default: false }))
      );
    }

    const fields = {};
    if (contenido !== undefined) fields.pack_size   = parseFloat(contenido);
    if (unidad    !== undefined) fields.unit         = unidad;
    if (precio    !== undefined) fields.price_cents  = Math.round(parseFloat(precio) * 100);
    if (precioB2b !== undefined) fields.b2b_price_cents = precioB2b != null ? Math.round(parseFloat(precioB2b) * 100) : null;
    if (cantidadB2b !== undefined) fields.min_qty_for_b2b = cantidadB2b != null ? parseInt(cantidadB2b) : null;
    if (stock     !== undefined) fields.stock        = parseFloat(stock) || 0;
    if (pedidoMinimo !== undefined) fields.min_order_qty = parseFloat(pedidoMinimo) || 1;
    if (orden     !== undefined) fields.sort_order   = parseInt(orden) || 0;
    if (predeterminada !== undefined) fields.is_default = predeterminada;
    if (molienda  !== undefined) fields.grind        = Array.isArray(molienda) ? molienda : [];

    const updated = await supabaseService.updatePresentation(presentationId, fields);
    res.json({ success: true, mensaje: 'Presentación actualizada', presentacion: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/productos/:businessId/:productId/presentaciones/:presentationId', async (req, res) => {
  try {
    const { businessId, presentationId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const supabaseService = require('../core/services/supabase-service');
    await supabaseService.deletePresentation(presentationId);
    res.json({ success: true, mensaje: 'Presentación eliminada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── RECETAS ─────────────────────────────────────────────────────────────────

// GET all recipes (optionally filtered by ?codigoDestino=XXX)
router.get('/recetas/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { codigoDestino } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    let recetas = await sheets.getRecetas();
    if (codigoDestino) recetas = recetas.filter(r => r.codigoDestino === codigoDestino);

    res.json({ recetas, total: recetas.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create recipe
router.post('/recetas/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { codigoDestino, nombreDestino, cantidadDestino, codigoOrigen, nombreOrigen, cantidadOrigen, descripcion } = req.body;

    if (!codigoDestino || !codigoOrigen || !cantidadDestino || !cantidadOrigen) {
      return res.status(400).json({ error: 'Required: codigoDestino, codigoOrigen, cantidadDestino, cantidadOrigen' });
    }
    if (cantidadDestino <= 0 || cantidadOrigen <= 0) {
      return res.status(400).json({ error: 'Quantities must be greater than 0' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    const result = await sheets.createReceta({ codigoDestino, nombreDestino, cantidadDestino, codigoOrigen, nombreOrigen, cantidadOrigen, descripcion });
    if (!result.success) return res.status(500).json({ error: result.error });

    res.status(201).json({ success: true, id: result.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update recipe
router.put('/recetas/:businessId/:recetaId', async (req, res) => {
  try {
    const { businessId, recetaId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    const result = await sheets.updateReceta(recetaId, req.body);
    if (!result.success) return res.status(404).json({ error: result.error });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE recipe
router.delete('/recetas/:businessId/:recetaId', async (req, res) => {
  try {
    const { businessId, recetaId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    const result = await sheets.deleteReceta(recetaId);
    if (!result.success) return res.status(404).json({ error: result.error });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET fulfillment plan for a specific pedido
// Returns per-product: direct stock status + recipe suggestions with viability
router.get('/recetas/:businessId/plan/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = await getSheetsServiceDirect(negocio);

    // Load all data in parallel
    const [inventario, recetas, pedidoRows] = await Promise.all([
      sheets.getProductos(),
      sheets.getRecetas(),
      sheets.getRows('Pedidos!A:U'),
    ]);

    // Find the pedido
    const pedidoRow = pedidoRows.slice(1).find(r => (r[0] || '').trim() === pedidoId);
    if (!pedidoRow) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Parse products string — format: "2x PROD-001 - Nombre: S/10.00, 1x PROD-002 - Nombre2: S/5.00"
    // or JSON array stored in column
    const productosRaw = pedidoRow[3] || '';
    const stockMap = Object.fromEntries(inventario.map(p => [p.codigo, p]));

    // Try to extract items: pattern "Nxxx CODIGO" or parse from JSON
    let items = [];
    try {
      const parsed = JSON.parse(productosRaw);
      if (Array.isArray(parsed)) {
        items = parsed.map(p => ({ codigo: p.codigo || p.id, nombre: p.nombre, cantidad: parseFloat(p.cantidad) || 1 }));
      }
    } catch (_) {
      // Fallback: parse text like "2x PROD-001 Café Tostado"
      const matches = [...productosRaw.matchAll(/(\d+(?:\.\d+)?)x?\s+([A-Z0-9\-]+)/g)];
      items = matches.map(m => ({ codigo: m[2], cantidad: parseFloat(m[1]) || 1, nombre: '' }));
    }

    // Build fulfillment plan per product
    const plan = items.map(item => {
      const producto = stockMap[item.codigo];
      const stockActual = producto ? producto.stock : 0;
      const necesita   = item.cantidad;
      const deficit    = Math.max(0, necesita - stockActual);

      // Find recipes that produce this product
      const sugerencias = recetas
        .filter(r => r.codigoDestino === item.codigo)
        .map(r => {
          const origen = stockMap[r.codigoOrigen];
          const stockOrigen = origen ? origen.stock : 0;
          // How many "batches" of the recipe are needed to cover the deficit
          const batchesNecesarios = deficit > 0 ? Math.ceil(deficit / r.cantidadDestino) : 0;
          const origenNecesario   = batchesNecesarios * r.cantidadOrigen;
          const posible           = stockOrigen >= origenNecesario;
          const maxProducible     = r.cantidadOrigen > 0 ? Math.floor(stockOrigen / r.cantidadOrigen) * r.cantidadDestino : 0;

          return {
            recetaId:         r.id,
            descripcion:      r.descripcion,
            codigoOrigen:     r.codigoOrigen,
            nombreOrigen:     r.nombreOrigen || (origen ? origen.nombre : r.codigoOrigen),
            stockOrigen,
            cantidadOrigen:   r.cantidadOrigen,
            cantidadDestino:  r.cantidadDestino,
            origenNecesario,
            posible,
            maxProducible,
            stockOrigenInsuficiente: !posible ? origenNecesario - stockOrigen : 0,
          };
        });

      return {
        codigo:      item.codigo,
        nombre:      item.nombre || (producto ? producto.nombre : item.codigo),
        cantidad:    necesita,
        stockActual,
        deficit,
        cubierto:    deficit === 0,
        parcial:     stockActual > 0 && deficit > 0,
        sugerencias,
      };
    });

    const todoCubierto = plan.every(p => p.cubierto);
    const algunoSinStock = plan.some(p => p.stockActual === 0 && p.deficit > 0);

    res.json({ pedidoId, plan, todoCubierto, algunoSinStock });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PRE-VENTAS ───────────────────────────────────────────────────────────────

// GET /api/preventas/:businessId/eventos
// Lista los eventos con offers disponibles para la farm del negocio
router.get('/preventas/:businessId/eventos', async (req, res) => {
  try {
    const negocio = negociosService.getById(req.params.businessId);
    if (!negocio.plataformaExterna || !negocio.farmId) {
      return res.status(400).json({ error: 'Negocio no compatible con pre-ventas' });
    }
    const eventos = await supabaseService.getEventOffers(negocio.farmId);
    res.json(eventos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/preventas/:businessId
// Crea una pre-orden para un cliente
router.post('/preventas/:businessId', async (req, res) => {
  try {
    const negocio = negociosService.getById(req.params.businessId);
    if (!negocio.plataformaExterna || !negocio.farmId) {
      return res.status(400).json({ error: 'Negocio no compatible con pre-ventas' });
    }
    const { offerId, sourceEventId, presentationId, cantidad, cliente } = req.body;
    if (!offerId || !sourceEventId || !cliente?.nombre || !cliente?.whatsapp) {
      return res.status(400).json({ error: 'Faltan campos: offerId, sourceEventId, cliente.nombre, cliente.whatsapp' });
    }
    const result = await supabaseService.createPreorden({
      farmId:         negocio.farmId,
      offerId,
      sourceEventId,
      presentationId: presentationId || null,
      cantidad:       cantidad || 1,
      cliente
    });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
