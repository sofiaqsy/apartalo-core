/**
 * PEDIDOS ROUTER - Gestión completa de pedidos (Supabase only)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const WhatsAppService = require('../core/services/whatsapp-service');
const supabaseService = require('../core/services/supabase-service');

// ==================== GET PEDIDOS ====================

/**
 * GET /:businessId
 *
 * Query params:
 *   - vista: PENDIENTES | HISTORIAL | POR_COBRAR | PAGADOS | MUESTRAS
 *   - estado: filtro directo por estado del pedido
 *   - estadoPago: filtro directo por estado de pago
 *   - cliente: búsqueda por nombre de cliente
 *   - fecha: filtro por fecha exacta
 *   - pagina: número de página (default 1)
 *   - limite: pedidos por página (default 50)
 */
router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, estadoPago, cliente, fecha, vista, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const result = await supabaseService.getOrdersByFarm(negocio.farmId, { vista, estado, estadoPago, cliente, fecha, pagina, limite });
    return res.json(result);
  } catch (error) {
    console.error('❌ Error obteniendo pedidos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== GET PEDIDO BY ID ====================

router.get('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    return res.json(pedido);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EVIDENCIAS DE PAGO ====================

router.post('/:businessId/:pedidoId/evidencias', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { url, tipo, descripcion } = req.body;

    // url es opcional para evidencias BCP auto-generadas (sin imagen de voucher)

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    const sid = pedido.supabaseId;

    let paymentId = req.body.paymentId || pedido.pagos?.[0]?.id || null;
    if (!paymentId) {
      const pago = await supabaseService.addOrderPayment(sid, { amountCents: 0, notes: 'Creado automáticamente para comprobante', createdBy: 'APP' });
      paymentId = pago?.id || null;
    }
    if (!paymentId) return res.status(500).json({ error: 'No se pudo crear registro de pago para el comprobante' });

    const proof = await supabaseService.addPaymentProof(paymentId, { url, source: tipo || 'APP', notes: descripcion || '' });
    return res.json({
      success: true,
      evidencia: { id: proof?.id, paymentId, url, tipo: tipo || 'APP', fecha: proof?.created_at || new Date().toISOString(), descripcion: descripcion || '' },
      totalEvidencias: (pedido.evidencias?.length || 0) + 1
    });
  } catch (error) {
    console.error('❌ Error agregando evidencia:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:businessId/:pedidoId/evidencias', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    return res.json({ evidencias: pedido.evidencias || [] });
  } catch (error) {
    console.error('❌ Error obteniendo evidencias:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== VERIFICAR EVIDENCIA CONTRA BCP ====================

router.put('/:businessId/:pedidoId/evidencias/:evidenciaId/verificar', async (req, res) => {
  try {
    const { businessId, pedidoId, evidenciaId } = req.params;
    const { operacionBCP, montoVerificado, fechaOperacion } = req.body;

    // operacionBCP puede ser vacío si el banco no incluyó número de operación

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    await supabaseService.verifyPaymentProof(evidenciaId, {
      bcpOpCode: operacionBCP,
      amountVerifiedCents: montoVerificado ? Math.round(parseFloat(montoVerificado) * 100) : null,
      verifiedBy: 'ADMIN'
    });
    return res.json({ success: true, evidenciaId, operacionBCP });
  } catch (error) {
    console.error('❌ Error verificando evidencia:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:businessId/:pedidoId/evidencias/:evidenciaId', async (req, res) => {
  try {
    const { businessId, pedidoId, evidenciaId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    await supabaseService.deletePaymentProof(evidenciaId);
    return res.json({ success: true, message: 'Evidencia eliminada' });
  } catch (error) {
    console.error('❌ Error eliminando evidencia:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CREAR PEDIDO ====================

router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      whatsapp, cliente, telefono, direccion, productos, total,
      observaciones, tipoEnvio, empresaEnvio, notificarCliente,
      estadoPago, montoPagado, ciudad, departamento,
      tipo, sourceEventId, negocioSolicitante
    } = req.body;

    if (!whatsapp) return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    if (!productos || (Array.isArray(productos) && productos.length === 0)) {
      return res.status(400).json({ error: 'Campo requerido: productos' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const clienteFinal      = cliente      || '';
    const telefonoFinal     = telefono     || '';
    const direccionFinal    = direccion    || '';
    const ciudadFinal       = ciudad       || '';
    const departamentoFinal = departamento || '';
    const tipoEnvioFinal    = tipoEnvio    || '';
    const whatsappFinal     = (whatsapp || '').replace(/[^0-9]/g, '');

    const customer = await supabaseService.getCustomerByPhone(whatsappFinal);
    const productosArr = Array.isArray(productos) ? productos : [];
    const items = productosArr.map(p => ({
      productId:       p.codigo || p.id || '',
      productName:     p.nombre || p.name || '',
      unit:            p.unidad || p.unit || 'unidad',
      presentacionId:  p.presentacionId || null,
      grind:           p.grind || null,
      quantity:        p.cantidad || p.quantity || 1,
      unitPriceCents:  Math.round((p.precio || p.price || 0) * 100),
      lineTotalCents:  Math.round(((p.subtotal) || (p.precio || 0) * (p.cantidad || 1)) * 100),
      commissionRate:  negocio.commission_rate || 0.10
    }));

    const esPreventa = tipo === 'PREVENTA';
    const notasFinal = esPreventa
      ? `[PRE-VENTA:${sourceEventId || ''}] ${observaciones || ''}`.trim()
      : (observaciones || '');

    const order = await supabaseService.createOrder({
      customer: {
        id: customer?.id || null,
        email: customer?.email || `${whatsappFinal}@whatsapp.apartalo.co`,
        fullName: clienteFinal || '',
        phone: whatsappFinal
      },
      farmId: negocio.farmId,
      items,
      shippingAddress: {
        line1: direccionFinal,
        city: ciudadFinal,
        department: departamentoFinal,
        tipo: tipoEnvioFinal,
        courier: empresaEnvio || ''
      },
      notes: notasFinal,
      esPreventa,
      paymentMethod: null,
      currency: 'PEN'
    });

    if (!order) return res.status(500).json({ error: 'Error creando pedido en Supabase' });

    if (notificarCliente) {
      try {
        const ws = new WhatsAppService(negocio.whatsapp);
        const productosTexto = items.map(i => `${i.quantity}x ${i.productName}`).join('\n');
        await ws.sendMessage(whatsappFinal, `✅ *Pedido Registrado*\n\n📋 *ID:* ${order.order_number}\n\n*Productos:*\n${productosTexto}\n\n💰 *Total:* S/ ${(order.total_cents / 100).toFixed(2)}\n\nTe avisaremos cuando esté listo. ¡Gracias! 🙏`);
      } catch (e) { console.error('⚠️ Error notificando cliente:', e.message); }
    }

    // Retornar el pedido completo para que la app pueda mostrar el detalle de inmediato
    const pedidoCompleto = await supabaseService.getOrderByIdOrNumber(order.order_number);

    return res.status(201).json({
      success: true,
      mensaje: 'Pedido creado',
      pedido: pedidoCompleto || { id: order.order_number, supabaseId: order.id, estado: 'PENDIENTE', estadoPago: 'PENDIENTE_PAGO' }
    });
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACTUALIZAR PEDIDO ====================

router.put('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const {
      estado, observaciones, direccion,
      estadoPago, montoPagado,
      nuevoPago, notaPago,
      notificarCliente
    } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    const sid = pedido.supabaseId;

    if (estado !== undefined) await supabaseService.updateOrderStatus(sid, estado);

    const orderUpdates = {};
    if (observaciones !== undefined) orderUpdates.notes = observaciones;
    if (direccion !== undefined) {
      const addr = pedido._rawAddress || {};
      orderUpdates.shipping_address = { ...addr, line1: direccion };
    }
    if (Object.keys(orderUpdates).length > 0) await supabaseService.updateOrderFields(sid, orderUpdates);

    if (nuevoPago !== undefined && parseFloat(nuevoPago) > 0) {
      await supabaseService.addOrderPayment(sid, {
        amountCents: Math.round(parseFloat(nuevoPago) * 100),
        notes: notaPago || '',
        createdBy: 'APP'
      });
    } else if (estadoPago !== undefined) {
      const psMap = { PAGADO: 'paid', PARCIAL: 'partial', PENDIENTE_PAGO: 'pending' };
      await supabaseService.updateOrderFields(sid, { payment_status: psMap[estadoPago] || 'pending' });
    }

    if (notificarCliente && estado) {
      try {
        const ws = new WhatsAppService(negocio.whatsapp);
        const msgs = {
          CONFIRMADO:     `✅ Tu pedido *${pedido.id}* ha sido confirmado.`,
          EN_PREPARACION: `📦 Tu pedido *${pedido.id}* está en preparación.`,
          LISTO:          `✅ Tu pedido *${pedido.id}* está listo.`,
          ENVIADO:        `🚚 Tu pedido *${pedido.id}* ha sido enviado.`,
          COMPLETADO:     `✅ Tu pedido *${pedido.id}* ha sido completado. ¡Gracias!`,
          CANCELADO:      `❌ Tu pedido *${pedido.id}* ha sido cancelado.`
        };
        const msg = msgs[estado.toUpperCase()];
        if (msg) await ws.sendMessage(pedido.whatsapp, msg);
      } catch (e) { console.error('⚠️ Error notificando:', e.message); }
    }

    return res.json({ success: true, mensaje: 'Pedido actualizado', pedidoId });
  } catch (error) {
    console.error('❌ Error actualizando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ELIMINAR PEDIDO ====================

router.delete('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    if (pedido._status !== 'pending_payment') {
      return res.status(403).json({ error: 'Solo se pueden eliminar pedidos en estado PENDIENTE', estadoActual: pedido.estado, pedidoId });
    }

    await supabaseService.updateOrderFields(pedido.supabaseId, { status: 'cancelled' });
    return res.json({ success: true, mensaje: 'Pedido cancelado/eliminado', pedidoId });
  } catch (error) {
    console.error('❌ Error eliminando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
