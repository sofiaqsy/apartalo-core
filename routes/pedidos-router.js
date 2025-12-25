/**
 * PEDIDOS ROUTER - Gestión completa de pedidos
 * 
 * Columnas en Google Sheets (Pedidos):
 * A: ID
 * B: Fecha
 * C: Hora
 * D: WhatsApp
 * E: Cliente
 * F: Teléfono
 * G: Dirección
 * H: Productos (JSON o texto)
 * I: Total
 * J: Estado
 * K: VoucherUrls
 * L: Observaciones
 * M: TipoEnvio
 * N: EmpresaEnvio
 * O: Origen (APP/BOT/WEB)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');

/**
 * GET /api/pedidos/:businessId
 * Listar pedidos con filtros
 */
router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, cliente, fecha, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Pedidos!A:O');

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
        voucherUrls: row[10] || '',
        observaciones: row[11] || '',
        tipoEnvio: row[12] || '',
        empresaEnvio: row[13] || '',
        origen: row[14] || 'BOT',
        rowIndex: i + 1
      };

      // Filtros
      if (estado && pedido.estado !== estado) continue;
      if (cliente && !pedido.cliente.toLowerCase().includes(cliente.toLowerCase())) continue;
      if (fecha && pedido.fecha !== fecha) continue;

      pedidos.push(pedido);
    }

    // Más recientes primero
    pedidos.reverse();

    // Paginación
    const total = pedidos.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 50;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;
    const pedidosPaginados = pedidos.slice(inicio, inicio + limiteNum);

    res.json({
      total,
      pagina: paginaNum,
      totalPaginas,
      hayMas: paginaNum < totalPaginas,
      pedidos: pedidosPaginados
    });

  } catch (error) {
    console.error('❌ Error obteniendo pedidos:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/pedidos/:businessId/:pedidoId
 * Obtener detalle de un pedido
 */
router.get('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Pedidos!A:O');

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
          voucherUrls: rows[i][10] || '',
          observaciones: rows[i][11] || '',
          tipoEnvio: rows[i][12] || '',
          empresaEnvio: rows[i][13] || '',
          origen: rows[i][14] || 'BOT',
          rowIndex: i + 1
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });

  } catch (error) {
    console.error('❌ Error obteniendo pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/pedidos/:businessId
 * Crear nuevo pedido
 */
router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      whatsapp,
      cliente,
      telefono,
      direccion,
      productos, // Array de {codigo, nombre, cantidad, precio, subtotal}
      total,
      observaciones,
      tipoEnvio,
      empresaEnvio,
      notificarCliente
    } = req.body;

    // Validaciones
    if (!whatsapp) {
      return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    }
    if (!productos || (Array.isArray(productos) && productos.length === 0)) {
      return res.status(400).json({ error: 'Campo requerido: productos' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // Generar ID y timestamp
    const pedidoId = `PED-${Date.now().toString().slice(-8)}`;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-PE');
    const hora = ahora.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });

    // Formatear productos para guardar
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

    // Estructura: 15 columnas (A-O)
    const valores = [
      pedidoId,                    // A: ID
      fecha,                       // B: Fecha
      hora,                        // C: Hora
      whatsapp.replace(/[^0-9]/g, ''), // D: WhatsApp
      cliente || '',               // E: Cliente
      telefono || '',              // F: Teléfono
      direccion || '',             // G: Dirección
      productosTexto,              // H: Productos
      totalFinal,                  // I: Total
      'PENDIENTE',                 // J: Estado
      '',                          // K: VoucherUrls
      observaciones || '',         // L: Observaciones
      tipoEnvio || '',             // M: TipoEnvio
      empresaEnvio || '',          // N: EmpresaEnvio
      'APP'                        // O: Origen
    ];

    await sheets.appendRow('Pedidos', valores);

    // Actualizar stock si los productos tienen código
    if (Array.isArray(productos)) {
      for (const p of productos) {
        if (p.codigo) {
          try {
            const rows = await sheets.getRows(negocio.spreadsheetId, 'Inventario!A:F');
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

    // Notificar al cliente por WhatsApp si se solicita
    if (notificarCliente) {
      try {
        const whatsappService = new WhatsAppService(negocio.whatsapp);
        const mensaje = `✅ *Pedido Registrado*\n\n` +
          `📋 *ID:* ${pedidoId}\n` +
          `📅 ${fecha} ${hora}\n\n` +
          `*Productos:*\n${productosTexto}\n\n` +
          `💰 *Total:* S/ ${totalFinal.toFixed(2)}\n\n` +
          `Te avisaremos cuando esté listo. ¡Gracias! 🙏`;
        
        await whatsappService.sendMessage(whatsapp.replace(/[^0-9]/g, ''), mensaje);
      } catch (e) {
        console.error('⚠️ Error notificando cliente:', e.message);
      }
    }

    res.status(201).json({
      success: true,
      mensaje: 'Pedido creado',
      pedido: {
        id: pedidoId,
        fecha,
        hora,
        whatsapp: whatsapp.replace(/[^0-9]/g, ''),
        cliente: cliente || '',
        productos: productosTexto,
        total: totalFinal,
        estado: 'PENDIENTE',
        origen: 'APP'
      }
    });

  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/pedidos/:businessId/:pedidoId
 * Actualizar pedido
 */
router.put('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const {
      estado,
      observaciones,
      direccion,
      tipoEnvio,
      empresaEnvio,
      voucherUrls,
      notificarCliente
    } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Pedidos!A:O');

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

        if (updates.length > 0) {
          await sheets.batchUpdate(updates);
        }

        // Notificar cambio de estado
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
            if (mensaje) {
              await whatsappService.sendMessage(clienteWhatsapp, mensaje);
            }
          } catch (e) {
            console.error('⚠️ Error notificando cliente:', e.message);
          }
        }

        return res.json({
          success: true,
          mensaje: 'Pedido actualizado',
          pedidoId
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });

  } catch (error) {
    console.error('❌ Error actualizando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/pedidos/:businessId/:pedidoId
 * Eliminar pedido (soft delete)
 */
router.delete('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Pedidos!A:B');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        await sheets.updateCell(`Pedidos!A${i + 1}`, `${pedidoId}_DELETED_${Date.now()}`);
        await sheets.updateCell(`Pedidos!J${i + 1}`, 'ELIMINADO');

        return res.json({
          success: true,
          mensaje: 'Pedido eliminado',
          pedidoId
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });

  } catch (error) {
    console.error('❌ Error eliminando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
