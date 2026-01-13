/**
 * PEDIDOS ROUTER - Gestión completa de pedidos
 * FIX: getRows() solo recibe 'range' (sheets-service usa this.spreadsheetId internamente)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');

// ==================== HELPER PARA PARSEAR EVIDENCIAS ====================

/**
 * Parsea el campo de evidencias desde string JSON o formato antiguo
 */
function parseEvidencias(voucherUrlsRaw) {
  if (!voucherUrlsRaw || voucherUrlsRaw.trim() === '') return [];
  
  try {
    // Intentar parsear como JSON
    const parsed = JSON.parse(voucherUrlsRaw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (e) {
    // Formato antiguo: URLs separadas por coma o salto de línea
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

/**
 * Serializa las evidencias a JSON para guardar en la hoja
 */
function serializeEvidencias(evidencias) {
  if (!evidencias || evidencias.length === 0) return '';
  return JSON.stringify(evidencias);
}

// ==================== GET PEDIDOS ====================

router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, cliente, fecha, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:O');

    let pedidos = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0] || row[0].includes('_DELETED')) continue;

      const pedido = {
        id: row[0] || '', fecha: row[1] || '', hora: row[2] || '', whatsapp: row[3] || '',
        cliente: row[4] || '', telefono: row[5] || '', direccion: row[6] || '',
        productos: row[7] || '', total: parseFloat(row[8]) || 0, estado: row[9] || 'PENDIENTE',
        evidencias: parseEvidencias(row[10]), // Ahora parseamos como evidencias
        observaciones: row[11] || '', tipoEnvio: row[12] || '',
        empresaEnvio: row[13] || '', origen: row[14] || 'BOT', rowIndex: i + 1
      };

      if (estado && pedido.estado !== estado) continue;
      if (cliente && !pedido.cliente.toLowerCase().includes(cliente.toLowerCase())) continue;
      if (fecha && pedido.fecha !== fecha) continue;

      pedidos.push(pedido);
    }

    pedidos.reverse();

    const total = pedidos.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 50;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;

    res.json({ total, pagina: paginaNum, totalPaginas, hayMas: paginaNum < totalPaginas, pedidos: pedidos.slice(inicio, inicio + limiteNum) });
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:O');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        return res.json({
          id: rows[i][0], fecha: rows[i][1] || '', hora: rows[i][2] || '', whatsapp: rows[i][3] || '',
          cliente: rows[i][4] || '', telefono: rows[i][5] || '', direccion: rows[i][6] || '',
          productos: rows[i][7] || '', total: parseFloat(rows[i][8]) || 0, estado: rows[i][9] || 'PENDIENTE',
          evidencias: parseEvidencias(rows[i][10]), // Ahora parseamos como evidencias
          observaciones: rows[i][11] || '', tipoEnvio: rows[i][12] || '',
          empresaEnvio: rows[i][13] || '', origen: rows[i][14] || 'BOT', rowIndex: i + 1
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EVIDENCIAS DE PAGO ====================

/**
 * POST /:businessId/:pedidoId/evidencias
 * Agregar una evidencia de pago a un pedido
 */
router.post('/:businessId/:pedidoId/evidencias', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { url, tipo, fecha, descripcion } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Campo requerido: url' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        // Obtener evidencias actuales
        const evidenciasActuales = parseEvidencias(rows[i][10]);
        
        // Crear nueva evidencia
        const nuevaEvidencia = {
          id: `ev_${Date.now()}`,
          url,
          tipo: tipo || 'APP',
          fecha: fecha || new Date().toISOString(),
          descripcion: descripcion || ''
        };
        
        // Agregar a la lista
        evidenciasActuales.push(nuevaEvidencia);
        
        // Guardar en la hoja
        await sheets.updateCell(`Pedidos!K${i + 1}`, serializeEvidencias(evidenciasActuales));
        
        console.log(`✅ Evidencia agregada al pedido ${pedidoId}`);
        
        return res.json({
          success: true,
          evidencia: nuevaEvidencia,
          totalEvidencias: evidenciasActuales.length
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    console.error('❌ Error agregando evidencia:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /:businessId/:pedidoId/evidencias
 * Obtener todas las evidencias de un pedido
 */
router.get('/:businessId/:pedidoId/evidencias', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const evidencias = parseEvidencias(rows[i][10]);
        return res.json({ evidencias });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    console.error('❌ Error obteniendo evidencias:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /:businessId/:pedidoId/evidencias/:evidenciaId
 * Eliminar una evidencia específica
 */
router.delete('/:businessId/:pedidoId/evidencias/:evidenciaId', async (req, res) => {
  try {
    const { businessId, pedidoId, evidenciaId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        // Obtener evidencias actuales
        let evidencias = parseEvidencias(rows[i][10]);
        
        // Filtrar la evidencia a eliminar
        const evidenciasFiltradas = evidencias.filter(e => e.id !== evidenciaId);
        
        if (evidencias.length === evidenciasFiltradas.length) {
          return res.status(404).json({ error: 'Evidencia no encontrada' });
        }
        
        // Guardar en la hoja
        await sheets.updateCell(`Pedidos!K${i + 1}`, serializeEvidencias(evidenciasFiltradas));
        
        console.log(`🗑️ Evidencia ${evidenciaId} eliminada del pedido ${pedidoId}`);
        
        return res.json({
          success: true,
          message: 'Evidencia eliminada'
        });
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
    const { whatsapp, cliente, telefono, direccion, productos, total, observaciones, tipoEnvio, empresaEnvio, notificarCliente } = req.body;

    if (!whatsapp) return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    if (!productos || (Array.isArray(productos) && productos.length === 0)) return res.status(400).json({ error: 'Campo requerido: productos' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const pedidoId = `PED-${Date.now().toString().slice(-8)}`;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-PE');
    const hora = ahora.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });

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

    const valores = [
      pedidoId, fecha, hora, whatsapp.replace(/[^0-9]/g, ''),
      cliente || '', telefono || '', direccion || '', productosTexto, totalFinal,
      'PENDIENTE', '', observaciones || '', tipoEnvio || '', empresaEnvio || '', 'APP'
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
          } catch (e) { console.error(`⚠️ Error actualizando stock de ${p.codigo}:`, e.message); }
        }
      }
    }

    if (notificarCliente) {
      try {
        const whatsappService = new WhatsAppService(negocio.whatsapp);
        const mensaje = `✅ *Pedido Registrado*\n\n📋 *ID:* ${pedidoId}\n📅 ${fecha} ${hora}\n\n*Productos:*\n${productosTexto}\n\n💰 *Total:* S/ ${totalFinal.toFixed(2)}\n\nTe avisaremos cuando esté listo. ¡Gracias! 🙏`;
        await whatsappService.sendMessage(whatsapp.replace(/[^0-9]/g, ''), mensaje);
      } catch (e) { console.error('⚠️ Error notificando cliente:', e.message); }
    }

    res.status(201).json({ success: true, mensaje: 'Pedido creado', pedido: { id: pedidoId, fecha, hora, whatsapp: whatsapp.replace(/[^0-9]/g, ''), cliente: cliente || '', productos: productosTexto, total: totalFinal, estado: 'PENDIENTE', origen: 'APP', evidencias: [] } });
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACTUALIZAR PEDIDO ====================

router.put('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { estado, observaciones, direccion, tipoEnvio, empresaEnvio, voucherUrls, notificarCliente } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:O');

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

        if (updates.length > 0) await sheets.batchUpdate(updates);

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
              'CANCELADO': `❌ Tu pedido *${pedidoId}* ha sido cancelado.`
            };
            const mensaje = mensajesEstado[estado];
            if (mensaje) await whatsappService.sendMessage(clienteWhatsapp, mensaje);
          } catch (e) { console.error('⚠️ Error notificando cliente:', e.message); }
        }

        return res.json({ success: true, mensaje: 'Pedido actualizado', pedidoId });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ELIMINAR PEDIDO ====================

router.delete('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Pedidos!A:B');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        await sheets.updateCell(`Pedidos!A${i + 1}`, `${pedidoId}_DELETED_${Date.now()}`);
        await sheets.updateCell(`Pedidos!J${i + 1}`, 'ELIMINADO');
        return res.json({ success: true, mensaje: 'Pedido eliminado', pedidoId });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
