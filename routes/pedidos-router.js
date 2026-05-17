/**
 * PEDIDOS ROUTER - Gestión completa de pedidos
 * ACTUALIZACIÓN: Filtro 'vista' para paginación eficiente desde la app
 * ACTUALIZACIÓN: Pagos parciales acumulados (col S = JSON array de pagos)
 * ACTUALIZACIÓN: Vista MUESTRAS para pedidos de café gratis
 * FIX: getRows() solo recibe 'range' (sheets-service usa this.spreadsheetId internamente)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');
const deliveryService = require('../core/services/delivery-service');
const supabaseService = require('../core/services/supabase-service');

// ==================== HELPERS ====================

function parseEvidencias(voucherUrlsRaw) {
  if (!voucherUrlsRaw || voucherUrlsRaw.trim() === '') return [];
  try {
    const parsed = JSON.parse(voucherUrlsRaw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (e) {
    const urls = voucherUrlsRaw.split(/[,\n]/).map(u => u.trim()).filter(u => u);
    return urls.map((url, index) => ({
      id: `ev_legacy_${index}`,
      url,
      tipo: 'WHATSAPP',
      fecha: new Date().toISOString(),
      descripcion: 'Evidencia migrada'
    }));
  }
}

function serializeEvidencias(evidencias) {
  if (!evidencias || evidencias.length === 0) return '';
  return JSON.stringify(evidencias);
}

function parsePagos(pagosRaw) {
  if (!pagosRaw || pagosRaw.trim() === '') return [];
  try {
    const parsed = JSON.parse(pagosRaw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function serializePagos(pagos) {
  if (!pagos || pagos.length === 0) return '';
  return JSON.stringify(pagos);
}

// ── Tracking helpers ──────────────────────────────────────────────────────────
// Solo registra cambios de estado significativos (CREADO, CONFIRMADO, COMPLETADO, etc.)
const ESTADOS_TRACKING = new Set(['CREADO', 'CONFIRMADO', 'EN_PREPARACION', 'LISTO', 'ENVIADO', 'ENTREGADO', 'COMPLETADO', 'CANCELADO']);

function nowPeru() {
  const now = new Date();
  return now.toLocaleString('es-PE', { timeZone: 'America/Lima', hour12: true });
}

function parseTracking(raw) {
  if (!raw || raw.trim() === '') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function updateTracking(raw, nuevoEstado) {
  const ts = nowPeru();
  const existing = parseTracking(raw);
  if (!existing) {
    return JSON.stringify({ creadoEn: ts, actualizadoEn: ts, estados: [{ estado: nuevoEstado, fecha: ts }] });
  }
  const estados = existing.estados || [];
  estados.push({ estado: nuevoEstado, fecha: ts });
  return JSON.stringify({ ...existing, actualizadoEn: ts, estados });
}

function determinarEstadoPago(pedido) {
  const estadoPagoExplicito = (pedido.estadoPago || '').toUpperCase();
  if (estadoPagoExplicito && estadoPagoExplicito !== '' && estadoPagoExplicito !== 'PENDIENTE_PAGO') {
    if (estadoPagoExplicito === 'PAGADO' || estadoPagoExplicito === 'PARCIAL') {
      return estadoPagoExplicito;
    }
  }

  const total = pedido.total || 0;
  const montoPagado = pedido.montoPagado || 0;

  if (montoPagado >= total && total > 0) return 'PAGADO';
  if (montoPagado > 0 && montoPagado < total) return 'PARCIAL';

  const evidencias = pedido.evidencias || [];
  if (evidencias.length > 0) return 'PAGADO';

  return 'PENDIENTE_PAGO';
}

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
    const { estado, estadoPago, cliente, fecha, vista, tipo, negocioSolicitante, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      const result = await supabaseService.getOrdersByFarm(negocio.farmId, { vista, estado, estadoPago, cliente, fecha, pagina, limite });
      return res.json(result);
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // A:W incluye tipo (T), negocioSolicitante (U), fechaActualizacion (V), tracking JSON (W)
    const rows = await sheets.getRows('Pedidos!A:W');

    let pedidos = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0] || row[0].includes('_DELETED')) continue;

      const pedido = {
        id: row[0] || '',
        fecha: row[1] || '',
        hora: row[2] || '',
        whatsapp: row[3] || '',
        cliente: row[4] || '',
        telefono: row[5] || '',
        direccion: row[6] || '',
        productos: row[7] || '',
        total: parseFloat(row[8]) || 0,
        estado: row[9] || 'PENDIENTE',
        evidencias: parseEvidencias(row[10]),
        observaciones: row[11] || '',
        tipoEnvio: row[12] || '',
        empresaEnvio: row[13] || '',
        origen: row[14] || 'BOT',
        estadoPago: row[15] || 'PENDIENTE_PAGO',
        montoPagado: parseFloat(row[16]) || 0,
        fechaPago: row[17] || '',
        pagos: parsePagos(row[18]),
        tipo: row[19] || '',
        negocioSolicitante: row[20] || '',
        fechaActualizacion: row[21] || '',
        tracking: parseTracking(row[22]),
        rowIndex: i + 1
      };

      // ========== FILTRO POR VISTA (compuesto) ==========
      if (vista) {
        const estadoUpper = pedido.estado.toUpperCase();
        const estadoPagoEfectivo = determinarEstadoPago(pedido);
        const observacionesUpper = pedido.observaciones.toUpperCase();
        // Muestra = tiene 'MUESTRA' en observaciones O total es 0
        const esMuestra = observacionesUpper.includes('MUESTRA') || pedido.total === 0;

        switch (vista.toUpperCase()) {
          case 'PENDIENTES':
            // Excluir completados, cancelados y muestras
            if (estadoUpper === 'COMPLETADO' || estadoUpper === 'CANCELADO') continue;
            if (esMuestra) continue;
            break;

          case 'HISTORIAL':
            if (estadoUpper !== 'COMPLETADO' && estadoUpper !== 'CANCELADO') continue;
            break;

          case 'POR_COBRAR':
            if (estadoUpper !== 'COMPLETADO') continue;
            if (estadoPagoEfectivo === 'PAGADO') continue;
            break;

          case 'PAGADOS':
            if (estadoUpper !== 'COMPLETADO' && estadoUpper !== 'CANCELADO') continue;
            if (estadoPagoEfectivo !== 'PAGADO') continue;
            break;

          case 'MUESTRAS':
            // Pedidos de muestra: con 'MUESTRA' en observaciones o total = 0
            if (!esMuestra) continue;
            break;
        }
      }

      // ========== FILTROS DIRECTOS (compatibilidad) ==========
      if (estado && pedido.estado !== estado) continue;
      if (estadoPago) {
        const estadoPagoEfectivo = determinarEstadoPago(pedido);
        if (estadoPagoEfectivo !== estadoPago.toUpperCase()) continue;
      }
      if (cliente && !pedido.cliente.toLowerCase().includes(cliente.toLowerCase())) continue;
      if (fecha && pedido.fecha !== fecha) continue;
      if (tipo && pedido.tipo !== tipo.toUpperCase()) continue;
      if (negocioSolicitante && pedido.negocioSolicitante !== negocioSolicitante) continue;

      pedidos.push(pedido);
    }

    pedidos.reverse();

    const total = pedidos.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 50;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;

    res.json({
      total,
      pagina: paginaNum,
      totalPaginas,
      hayMas: paginaNum < totalPaginas,
      pedidos: pedidos.slice(inicio, inicio + limiteNum)
    });
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

    if (negocio.plataformaExterna) {
      const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.json(pedido);
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:S');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return res.json({
          id: rows[i][0],
          fecha: rows[i][1] || '',
          hora: rows[i][2] || '',
          whatsapp: rows[i][3] || '',
          cliente: rows[i][4] || '',
          telefono: rows[i][5] || '',
          direccion: rows[i][6] || '',
          productos: rows[i][7] || '',
          total: parseFloat(rows[i][8]) || 0,
          estado: rows[i][9] || 'PENDIENTE',
          evidencias: parseEvidencias(rows[i][10]),
          observaciones: rows[i][11] || '',
          tipoEnvio: rows[i][12] || '',
          empresaEnvio: rows[i][13] || '',
          origen: rows[i][14] || 'BOT',
          estadoPago: rows[i][15] || 'PENDIENTE_PAGO',
          montoPagado: parseFloat(rows[i][16]) || 0,
          fechaPago: rows[i][17] || '',
          pagos: parsePagos(rows[i][18]),
          rowIndex: i + 1
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EVIDENCIAS DE PAGO ====================

router.post('/:businessId/:pedidoId/evidencias', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { url, tipo, fecha, descripcion } = req.body;

    if (!url) return res.status(400).json({ error: 'Campo requerido: url' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
      const sid = pedido.supabaseId;

      // Attach proof to first existing payment, or create a zero-amount placeholder
      let paymentId = pedido.pagos?.[0]?.id || null;
      if (!paymentId) {
        const pago = await supabaseService.addOrderPayment(sid, { amountCents: 0, notes: 'Creado automáticamente para comprobante', createdBy: 'APP' });
        paymentId = pago?.id || null;
      }
      if (!paymentId) return res.status(500).json({ error: 'No se pudo crear registro de pago para el comprobante' });

      const proof = await supabaseService.addPaymentProof(paymentId, { url, source: tipo || 'APP', notes: descripcion || '' });
      return res.json({ success: true, evidencia: { id: proof?.id, paymentId, url, tipo: tipo || 'APP', fecha: proof?.created_at || new Date().toISOString(), descripcion: descripcion || '' }, totalEvidencias: (pedido.evidencias?.length || 0) + 1 });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const evidenciasActuales = parseEvidencias(rows[i][10]);
        const nuevaEvidencia = {
          id: `ev_${Date.now()}`,
          url,
          tipo: tipo || 'APP',
          fecha: fecha || new Date().toISOString(),
          descripcion: descripcion || ''
        };
        evidenciasActuales.push(nuevaEvidencia);
        await sheets.updateCell(`Pedidos!K${i + 1}`, serializeEvidencias(evidenciasActuales));
        console.log(`✅ Evidencia agregada al pedido ${pedidoId}`);
        return res.json({ success: true, evidencia: nuevaEvidencia, totalEvidencias: evidenciasActuales.length });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
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

    if (negocio.plataformaExterna) {
      const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.json({ evidencias: pedido.evidencias || [] });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return res.json({ evidencias: parseEvidencias(rows[i][10]) });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    console.error('❌ Error obteniendo evidencias:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== VERIFICAR EVIDENCIA CONTRA BCP ====================
// Marca una evidencia como VERIFICADO dentro de voucherUrls.
// NO actualiza estadoPago del pedido.
router.put('/:businessId/:pedidoId/evidencias/:evidenciaId/verificar', async (req, res) => {
  try {
    const { businessId, pedidoId, evidenciaId } = req.params;
    const { operacionBCP, montoVerificado, fechaOperacion } = req.body;

    if (!operacionBCP) return res.status(400).json({ error: 'Campo requerido: operacionBCP' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      await supabaseService.verifyPaymentProof(evidenciaId, {
        bcpOpCode: operacionBCP,
        amountVerifiedCents: montoVerificado ? Math.round(parseFloat(montoVerificado) * 100) : null,
        verifiedBy: 'ADMIN'
      });
      return res.json({ success: true, evidenciaId, operacionBCP });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:W');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] !== pedidoId) continue;

      const rowNum = i + 1;
      const evidencias = parseEvidencias(rows[i][10]);
      const evidenciaIdx = evidencias.findIndex(e => e.id === evidenciaId);

      if (evidenciaIdx === -1) return res.status(404).json({ error: 'Evidencia no encontrada' });

      // Solo actualiza la verificación dentro de la evidencia — estadoPago no se toca
      evidencias[evidenciaIdx].verificacion = {
        estado: 'VERIFICADO',
        operacionBCP,
        montoVerificado: parseFloat(montoVerificado) || 0,
        fechaVerificado: nowPeru(),
        fechaOperacion: fechaOperacion || ''
      };

      await sheets.batchUpdate([
        { range: `Pedidos!K${rowNum}`, value: serializeEvidencias(evidencias) },
        { range: `Pedidos!V${rowNum}`, value: nowPeru() },
      ]);

      console.log(`✅ Evidencia ${evidenciaId} verificada con BCP op: ${operacionBCP}`);
      return res.json({ success: true, evidenciaId, operacionBCP });
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
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

    if (negocio.plataformaExterna) {
      await supabaseService.deletePaymentProof(evidenciaId);
      return res.json({ success: true, message: 'Evidencia eliminada' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const evidencias = parseEvidencias(rows[i][10]);
        const evidenciasFiltradas = evidencias.filter(e => e.id !== evidenciaId);
        if (evidencias.length === evidenciasFiltradas.length) {
          return res.status(404).json({ error: 'Evidencia no encontrada' });
        }
        await sheets.updateCell(`Pedidos!K${i + 1}`, serializeEvidencias(evidenciasFiltradas));
        console.log(`🗑️ Evidencia ${evidenciaId} eliminada del pedido ${pedidoId}`);
        return res.json({ success: true, message: 'Evidencia eliminada' });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
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
      tipo, negocioSolicitante
    } = req.body;

    if (!whatsapp) return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    if (!productos || (Array.isArray(productos) && productos.length === 0)) {
      return res.status(400).json({ error: 'Campo requerido: productos' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    // ── B2B: enrich with requesting business data ──────────────────────────────
    let clienteFinal      = cliente    || '';
    let telefonoFinal     = telefono   || '';
    let direccionFinal    = direccion  || '';
    let ciudadFinal       = ciudad     || '';
    let departamentoFinal = departamento || '';
    let tipoEnvioFinal    = tipoEnvio  || '';
    // whatsappFinal: cleaned number, will be overridden from Configuracion for B2B
    let whatsappFinal     = (whatsapp || '').replace(/[^0-9]/g, '');

    if (tipo === 'B2B' && negocioSolicitante) {
      const negocioSol = negociosService.getById(negocioSolicitante);
      if (negocioSol) {
        if (!clienteFinal) clienteFinal = negocioSol.nombre || negocioSolicitante;

        // Read requesting business Configuracion sheet for all missing fields
        if (negocioSol.spreadsheetId) {
          try {
            const sheetsSol = new SheetsService(negocioSol.spreadsheetId);
            await sheetsSol.initialize();
            const configSolRows = await sheetsSol.getRows('Configuracion!A:B');
            const solConfig = {};
            for (let i = 1; i < configSolRows.length; i++) {
              const k = (configSolRows[i][0] || '').trim();
              const v = (configSolRows[i][1] || '').toString().trim();
              if (k) solConfig[k] = v;
            }
            if (!direccionFinal) direccionFinal = solConfig['direccion_tienda'] || solConfig['direccion'] || negocioSol.direccion || '';
            if (!ciudadFinal)    ciudadFinal    = solConfig['departamento']     || solConfig['ciudad']    || negocioSol.ciudad    || '';
            if (!telefonoFinal)  telefonoFinal  = solConfig['telefono']         || solConfig['phone']     || '';
            // Use real whatsapp number from config if the one passed looks invalid (< 6 digits)
            if (!whatsappFinal || whatsappFinal.length < 6) {
              whatsappFinal = (solConfig['whatsapp'] || solConfig['whatsapp_numero'] || solConfig['telefono'] || whatsappFinal).replace(/[^0-9]/g, '');
            }
            console.log(`[B2B] solConfig direccion="${direccionFinal}" ciudad="${ciudadFinal}" telefono="${telefonoFinal}" whatsapp="${whatsappFinal}"`);
          } catch (eSol) {
            console.error('[B2B] Error leyendo Configuracion del solicitante:', eSol.message);
            if (!direccionFinal) direccionFinal = negocioSol.direccion || '';
            if (!ciudadFinal)    ciudadFinal    = negocioSol.ciudad    || '';
          }
        }
      }
      if (!tipoEnvioFinal) tipoEnvioFinal = 'LOCAL';
    }

    if (negocio.plataformaExterna) {
      const customer = await supabaseService.getCustomerByPhone(whatsappFinal);
      const productosArr = Array.isArray(productos) ? productos : [];
      const items = productosArr.map(p => ({
        productId:      p.codigo || p.id || '',
        productName:    p.nombre || p.name || '',
        unit:           p.unidad || p.unit || 'unidad',
        quantity:       p.cantidad || p.quantity || 1,
        unitPriceCents: Math.round((p.precio || p.price || 0) * 100),
        lineTotalCents: Math.round(((p.subtotal) || (p.precio || 0) * (p.cantidad || 1)) * 100),
        commissionRate: negocio.commission_rate || 0.10
      }));
      const order = await supabaseService.createOrder({
        customer: {
          id: customer?.id || null,
          email: customer?.email || `${whatsappFinal}@whatsapp.apartalo.co`,
          fullName: clienteFinal || '', phone: whatsappFinal
        },
        farmId: negocio.farmId, items,
        shippingAddress: {
          line1: direccionFinal, city: ciudadFinal, department: departamentoFinal,
          tipo: tipoEnvioFinal, courier: empresaEnvio || ''
        },
        notes: observaciones || '', paymentMethod: null, currency: 'PEN'
      });
      if (!order) return res.status(500).json({ error: 'Error creando pedido en Supabase' });

      if (notificarCliente) {
        try {
          const ws = new WhatsAppService(negocio.whatsapp);
          const productosTexto = items.map(i => `${i.quantity}x ${i.productName}`).join('\n');
          await ws.sendMessage(whatsappFinal, `✅ *Pedido Registrado*\n\n📋 *ID:* ${order.order_number}\n\n*Productos:*\n${productosTexto}\n\n💰 *Total:* S/ ${(order.total_cents/100).toFixed(2)}\n\nTe avisaremos cuando esté listo. ¡Gracias! 🙏`);
        } catch (e) { console.error('⚠️ Error notificando cliente:', e.message); }
      }

      return res.status(201).json({
        success: true, mensaje: 'Pedido creado',
        pedido: { id: order.order_number, supabaseId: order.id, estado: 'PENDIENTE', estadoPago: 'PENDIENTE_PAGO' }
      });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const pedidoId = `PED-${Date.now().toString().slice(-8)}`;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
    const hora  = ahora.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });

    let productosTexto = '';
    let totalCalculado = 0;

    if (Array.isArray(productos)) {
      productosTexto = productos.map(p => {
        const subtotal = (p.cantidad || 1) * (p.precio || 0);
        totalCalculado += subtotal;
        return `${p.cantidad || 1}x ${p.nombre} - S/${subtotal.toFixed(2)}`;
      }).join('\n');
    } else {
      productosTexto = productos;
      totalCalculado = total || 0;
    }

    const totalFinal = total || totalCalculado;

    const tsCreacion = nowPeru();
    const trackingInicial = JSON.stringify({
      creadoEn: tsCreacion,
      actualizadoEn: tsCreacion,
      historial: [{ fecha: tsCreacion, accion: 'CREADO', campos: [] }]
    });

    const valores = [
      pedidoId, fecha, hora,
      whatsappFinal,
      clienteFinal, telefonoFinal, direccionFinal,
      productosTexto, totalFinal, 'PENDIENTE', '',
      observaciones || '', tipoEnvioFinal, empresaEnvio || '', 'APP',
      estadoPago || 'PENDIENTE_PAGO',
      montoPagado || 0,
      '', '',
      tipo ? tipo.toUpperCase() : '',   // T: tipo (B2B or empty)
      negocioSolicitante || '',          // U: businessId of requester
      tsCreacion,                        // V: fechaActualizacion
      trackingInicial                    // W: tracking JSON
    ];

    await sheets.appendRow('Pedidos', valores);

    if (Array.isArray(productos)) {
      for (const p of productos) {
        if (p.codigo) {
          try {
            const rows = await sheets.getRows('Inventario!A:F');
            for (let i = 1; i < rows.length; i++) {
              if (rows[i][0] === p.codigo) {
                const stockActual = parseInt(rows[i][4]) || 0;
                const nuevoStock = Math.max(0, stockActual - (p.cantidad || 1));
                await sheets.updateCell(`Inventario!E${i + 1}`, nuevoStock);
                break;
              }
            }
          } catch (e) {
            console.error(`⚠️ Error actualizando stock de ${p.codigo}:`, e.message);
          }
        }
      }
    }

    if (notificarCliente) {
      try {
        const whatsappService = new WhatsAppService(negocio.whatsapp);
        const mensaje = `✅ *Pedido Registrado*\n\n📋 *ID:* ${pedidoId}\n📅 ${fecha} ${hora}\n\n*Productos:*\n${productosTexto}\n\n💰 *Total:* S/ ${totalFinal.toFixed(2)}\n\nTe avisaremos cuando esté listo. ¡Gracias! 🙏`;
        await whatsappService.sendMessage(whatsappFinal, mensaje);
      } catch (e) {
        console.error('⚠️ Error notificando cliente:', e.message);
      }
    }

    // 🚚 Notify delivery business if applicable (fire-and-forget)
    const testMode = req.headers['x-test-mode'] === '1';
    console.log(`[Pedido] ciudad="${ciudadFinal}" departamento="${departamentoFinal}" direccion="${direccionFinal}"${testMode ? ' [TEST MODE]' : ''}`);
    deliveryService.notificarNuevoDelivery(
      { id: pedidoId, whatsapp: whatsappFinal, cliente: clienteFinal, telefono: telefonoFinal, direccion: direccionFinal, ciudad: ciudadFinal, departamento: departamentoFinal, productos: productosTexto, total: totalFinal, testMode },
      negocio,
      negociosService
    ).catch(e => console.error('⚠️ [Delivery] Error in delivery hook:', e.message));

    // 📦 Crear registro en hoja Delivery si el pedido tiene tipoEnvio configurado
    if (tipoEnvioFinal && tipoEnvioFinal.trim() !== '') try {
      const tipo_envio = tipoEnvioFinal.toUpperCase();

      // Leer dirección del negocio desde hoja Configuracion (clave-valor en A:B)
      let bizConfig = {};
      try {
        const configRows = await sheets.getRows('Configuracion!A:B');
        for (let i = 1; i < configRows.length; i++) {
          const k = (configRows[i][0] || '').trim();
          const v = (configRows[i][1] || '').toString().trim();
          if (k) bizConfig[k] = v;
        }
      } catch (_) { /* si no existe la hoja, usamos fallback */ }

      // Origen: siempre el negocio
      const origenNombre    = negocio.nombre || '';
      const origenDireccion = bizConfig['direccion_tienda'] || negocio.direccion || '';
      const origenCiudad    = bizConfig['departamento']     || negocio.ciudad    || '';

      // Destino: varía por tipo de envío
      let destinoNombre    = '';
      let destinoDireccion = '';
      let destinoCiudad    = [ciudadFinal, departamentoFinal].filter(Boolean).join(', ');

      if (tipo_envio === 'NACIONAL') {
        // Destino = agencia courier
        destinoNombre    = empresaEnvio  || 'Courier';
        destinoDireccion = direccionFinal || '';
      } else if (tipo_envio === 'SEDE') {
        // Destino = localEnvio registrado en la hoja Clientes (col R, index 17)
        let localEnvioCliente = '';
        try {
          const clientesRows = await sheets.getRows('Clientes!A:R');
          const whatsappLimpio = (whatsapp || '').replace(/[^0-9]/g, '');
          for (let ci = 1; ci < clientesRows.length; ci++) {
            const rowWa = (clientesRows[ci][1] || '').replace(/[^0-9]/g, '');
            if (rowWa === whatsappLimpio && !(clientesRows[ci][0] || '').includes('_DELETED')) {
              localEnvioCliente = (clientesRows[ci][17] || '').trim();
              break;
            }
          }
        } catch (eCli) { console.error('[Delivery/SEDE] Error leyendo Clientes:', eCli.message); }

        const sedeAddr   = localEnvioCliente || direccionFinal || '';
        const sedeCiudad = [ciudadFinal, departamentoFinal].filter(Boolean).join(', ') || origenCiudad;
        console.log(`[Delivery/SEDE] sedeAddr="${sedeAddr}"`);
        destinoNombre    = origenNombre;
        destinoDireccion = sedeAddr;
        destinoCiudad    = sedeCiudad;
      } else {
        // LOCAL / B2B: destino = dirección del cliente/negocio solicitante
        destinoNombre    = clienteFinal   || '';
        destinoDireccion = direccionFinal || '';
        destinoCiudad    = ciudadFinal    || '';
      }

      const deliveryId = `DEL-${Date.now().toString().slice(-8)}`;
      const ahora_delivery = new Date();
      const peru_delivery  = new Date(ahora_delivery.getTime() - 5 * 60 * 60 * 1000);
      const dd  = String(peru_delivery.getUTCDate()).padStart(2, '0');
      const mm  = String(peru_delivery.getUTCMonth() + 1).padStart(2, '0');
      const yy  = peru_delivery.getUTCFullYear();
      let   hh  = peru_delivery.getUTCHours();
      const min = String(peru_delivery.getUTCMinutes()).padStart(2, '0');
      const ap  = hh >= 12 ? 'p.m.' : 'a.m.';
      hh = hh % 12 || 12;
      const fechaDelivery = `${dd}/${mm}/${yy} ${hh}:${min} ${ap}`;

      // Para SEDE, origen y destino comparten la misma dirección (punto de recojo)
      const finalOrigenDireccion = tipo_envio === 'SEDE' ? destinoDireccion : origenDireccion;
      const finalOrigenCiudad    = tipo_envio === 'SEDE' ? destinoCiudad    : origenCiudad;

      const valoresDelivery = [
        deliveryId,
        pedidoId,
        tipo_envio,
        origenNombre,
        finalOrigenDireccion,
        finalOrigenCiudad,
        destinoNombre,
        destinoDireccion,
        destinoCiudad,
        tipo_envio === 'NACIONAL' ? (empresaEnvio || '') : '',
        negocioSolicitante || '',   // repartidorId
        'INACTIVO',
        fechaDelivery,
        '',   // fechaDisponible
        '',   // fechaEntrega
      ];

      await sheets.appendRow('Delivery', valoresDelivery);
      console.log(`[Delivery] Registro creado: ${deliveryId} → pedido ${pedidoId}`);
    } catch (eDelivery) {
      // No interrumpimos la respuesta si falla el registro de delivery
      console.error('⚠️ [Delivery] Error creando registro en hoja:', eDelivery.message);
    }

    res.status(201).json({
      success: true,
      mensaje: 'Pedido creado',
      pedido: {
        id: pedidoId, fecha, hora,
        whatsapp: whatsappFinal,
        cliente: clienteFinal || '',
        productos: productosTexto,
        total: totalFinal,
        estado: 'PENDIENTE',
        origen: 'APP',
        evidencias: [],
        estadoPago: estadoPago || 'PENDIENTE_PAGO',
        montoPagado: montoPagado || 0,
        fechaPago: '',
        pagos: [],
        tipo: tipo ? tipo.toUpperCase() : '',
        negocioSolicitante: negocioSolicitante || ''
      }
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
      estado, observaciones, direccion, tipoEnvio, empresaEnvio,
      voucherUrls, notificarCliente,
      estadoPago, montoPagado, fechaPago,
      nuevoPago, notaPago
    } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
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
          notes: notaPago || '', createdBy: 'APP'
        });
      } else if (estadoPago !== undefined) {
        const psMap = { PAGADO: 'paid', PARCIAL: 'partial', PENDIENTE_PAGO: 'pending' };
        await supabaseService.updateOrderFields(sid, { payment_status: psMap[estadoPago] || 'pending' });
      }

      if (notificarCliente && estado) {
        try {
          const ws = new WhatsAppService(negocio.whatsapp);
          const msgs = {
            CONFIRMADO: `✅ Tu pedido *${pedido.id}* ha sido confirmado.`,
            EN_PREPARACION: `📦 Tu pedido *${pedido.id}* está en preparación.`,
            LISTO: `✅ Tu pedido *${pedido.id}* está listo.`,
            ENVIADO: `🚚 Tu pedido *${pedido.id}* ha sido enviado.`,
            COMPLETADO: `✅ Tu pedido *${pedido.id}* ha sido completado. ¡Gracias!`,
            CANCELADO: `❌ Tu pedido *${pedido.id}* ha sido cancelado.`
          };
          const msg = msgs[estado.toUpperCase()];
          if (msg) await ws.sendMessage(pedido.whatsapp, msg);
        } catch (e) { console.error('⚠️ Error notificando:', e.message); }
      }

      return res.json({ success: true, mensaje: 'Pedido actualizado', pedidoId });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:W');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const updates = [];
        const rowNum = i + 1;

        if (estado !== undefined) updates.push({ range: `Pedidos!J${rowNum}`, value: estado });
        if (observaciones !== undefined) updates.push({ range: `Pedidos!L${rowNum}`, value: observaciones });
        if (direccion !== undefined) updates.push({ range: `Pedidos!G${rowNum}`, value: direccion });
        if (tipoEnvio !== undefined) updates.push({ range: `Pedidos!M${rowNum}`, value: tipoEnvio });
        if (empresaEnvio !== undefined) updates.push({ range: `Pedidos!N${rowNum}`, value: empresaEnvio });
        if (voucherUrls !== undefined) updates.push({ range: `Pedidos!K${rowNum}`, value: voucherUrls });

        if (estadoPago !== undefined) {
          updates.push({ range: `Pedidos!P${rowNum}`, value: estadoPago });
          if (estadoPago === 'PAGADO' && !fechaPago) {
            updates.push({ range: `Pedidos!R${rowNum}`, value: nowPeru() });
          }
        }

        if (nuevoPago !== undefined && parseFloat(nuevoPago) > 0) {
          const pagosActuales = parsePagos(rows[i][18]);
          pagosActuales.push({
            id: `pago_${Date.now()}`,
            monto: parseFloat(nuevoPago),
            fecha: nowPeru(),
            nota: notaPago || ''
          });
          const nuevoMontoPagadoTotal = pagosActuales.reduce(
            (sum, p) => sum + (parseFloat(p.monto) || 0), 0
          );
          updates.push({ range: `Pedidos!Q${rowNum}`, value: nuevoMontoPagadoTotal });
          updates.push({ range: `Pedidos!S${rowNum}`, value: serializePagos(pagosActuales) });
          console.log(`   → Nuevo pago: S/ ${nuevoPago} | Total acumulado: S/ ${nuevoMontoPagadoTotal}`);
        } else if (montoPagado !== undefined) {
          updates.push({ range: `Pedidos!Q${rowNum}`, value: montoPagado });
          if (parseFloat(montoPagado) === 0) {
            updates.push({ range: `Pedidos!S${rowNum}`, value: '' });
          }
        }

        if (fechaPago !== undefined) {
          updates.push({ range: `Pedidos!R${rowNum}`, value: fechaPago });
        }

        if (updates.length > 0) {
          // Solo registra en tracking si es un cambio de estado significativo
          const tsNow = nowPeru();
          let nuevoTracking = rows[i][22] || '';
          if (estado !== undefined && ESTADOS_TRACKING.has(estado.toUpperCase())) {
            nuevoTracking = updateTracking(nuevoTracking, estado.toUpperCase());
          }
          updates.push({ range: `Pedidos!V${rowNum}`, value: tsNow });
          updates.push({ range: `Pedidos!W${rowNum}`, value: nuevoTracking });
          await sheets.batchUpdate(updates);
        }

        if (notificarCliente && estado) {
          try {
            const whatsappService = new WhatsAppService(negocio.whatsapp);
            const clienteWhatsapp = rows[i][3];
            const mensajesEstado = {
              'CONFIRMADO': `✅ Tu pedido *${pedidoId}* ha sido confirmado. ¡Gracias!`,
              'EN_PREPARACION': `📦 Tu pedido *${pedidoId}* está en preparación.`,
              'LISTO': `✅ Tu pedido *${pedidoId}* está listo para envío/recojo.`,
              'ENVIADO': `🚚 Tu pedido *${pedidoId}* ha sido enviado. ¡Pronto llegará!`,
              'ENTREGADO': `✅ Tu pedido *${pedidoId}* ha sido entregado. ¡Gracias por tu compra!`,
              'CANCELADO': `❌ Tu pedido *${pedidoId}* ha sido cancelado.`,
              'COMPLETADO': `✅ Tu pedido *${pedidoId}* ha sido completado. ¡Gracias por tu compra!`
            };
            const mensaje = mensajesEstado[estado];
            if (mensaje) await whatsappService.sendMessage(clienteWhatsapp, mensaje);
          } catch (e) {
            console.error('⚠️ Error notificando cliente:', e.message);
          }
        }

        console.log(`✅ Pedido ${pedidoId} actualizado`);
        if (estadoPago) console.log(`   → Estado de pago: ${estadoPago}`);

        return res.json({ success: true, mensaje: 'Pedido actualizado', pedidoId });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    console.error('❌ Error actualizando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ELIMINAR PEDIDO (FÍSICO) ====================

router.delete('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna) {
      const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
      if (pedido._status !== 'pending_payment') {
        return res.status(403).json({ error: 'Solo se pueden eliminar pedidos en estado PENDIENTE', estadoActual: pedido.estado, pedidoId });
      }
      await supabaseService.updateOrderFields(pedido.supabaseId, { status: 'cancelled' });
      return res.json({ success: true, mensaje: 'Pedido cancelado/eliminado', pedidoId });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:J');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const estado = (rows[i][9] || 'PENDIENTE').toString().toUpperCase();

        if (estado !== 'PENDIENTE') {
          return res.status(403).json({
            error: 'Solo se pueden eliminar pedidos en estado PENDIENTE',
            estadoActual: estado,
            pedidoId
          });
        }

        const rowNumber = i + 1;

        try {
          const spreadsheetData = await sheets.sheets.spreadsheets.get({
            spreadsheetId: sheets.spreadsheetId
          });

          const pedidosSheet = spreadsheetData.data.sheets.find(
            sheet => sheet.properties.title === 'Pedidos'
          );

          if (!pedidosSheet) {
            return res.status(500).json({ error: 'Hoja Pedidos no encontrada' });
          }

          const sheetId = pedidosSheet.properties.sheetId;

          await sheets.sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheets.spreadsheetId,
            resource: {
              requests: [{
                deleteDimension: {
                  range: {
                    sheetId: sheetId,
                    dimension: 'ROWS',
                    startIndex: rowNumber - 1,
                    endIndex: rowNumber
                  }
                }
              }]
            }
          });

          console.log(`🗑️ Pedido ${pedidoId} eliminado físicamente (fila ${rowNumber}, estado: ${estado})`);

          return res.json({
            success: true,
            mensaje: 'Pedido eliminado permanentemente',
            pedidoId,
            estado
          });

        } catch (deleteError) {
          console.error('❌ Error eliminando fila:', deleteError);
          return res.status(500).json({
            error: 'Error al eliminar la fila del pedido',
            detalles: deleteError.message
          });
        }
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    console.error('❌ Error eliminando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
