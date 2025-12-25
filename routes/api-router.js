/**
 * APARTALO CORE - API Routes
 * 
 * Endpoints para:
 * - Enviar mensajes a clientes (asesor)
 * - Gestionar pedidos
 * - Admin panel
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const WhatsAppService = require('../core/services/whatsapp-service');
const SheetsService = require('../core/services/sheets-service');

// ============================================
// ENVIAR MENSAJE A CLIENTE (Asesor)
// ============================================

/**
 * POST /api/mensaje
 */
router.post('/mensaje', async (req, res) => {
  try {
    const { businessId, to, message, conversacionId } = req.body;

    if (!businessId || !to || !message) {
      return res.status(400).json({
        error: 'Faltan campos requeridos: businessId, to, message'
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendMessage(to, message);

    if (conversacionId) {
      const sheets = new SheetsService(negocio.spreadsheetId);
      await sheets.initialize();

      const timestamp = new Date().toISOString();
      const msgId = `MSG-${Date.now()}`;

      await sheets.appendRow('Mensajes', [
        msgId,
        conversacionId,
        timestamp,
        'ASESOR',
        message,
        negocio.nombre
      ]);
    }

    res.json({
      success: true,
      messageId: result.messages?.[0]?.id,
      to,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error enviando mensaje:', error);
    res.status(500).json({
      error: 'Error enviando mensaje',
      details: error.message
    });
  }
});

/**
 * POST /api/mensaje/imagen
 */
router.post('/mensaje/imagen', async (req, res) => {
  try {
    const { businessId, to, imageUrl, caption } = req.body;

    if (!businessId || !to || !imageUrl) {
      return res.status(400).json({
        error: 'Faltan campos: businessId, to, imageUrl'
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendImage(to, imageUrl, caption || '');

    res.json({
      success: true,
      messageId: result.messages?.[0]?.id
    });

  } catch (error) {
    console.error('❌ Error enviando imagen:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mensaje/botones
 */
router.post('/mensaje/botones', async (req, res) => {
  try {
    const { businessId, to, text, buttons } = req.body;

    if (!businessId || !to || !text || !buttons) {
      return res.status(400).json({
        error: 'Faltan campos: businessId, to, text, buttons'
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendButtonMessage(to, text, buttons);

    res.json({
      success: true,
      messageId: result.messages?.[0]?.id
    });

  } catch (error) {
    console.error('❌ Error enviando botones:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CONVERSACIONES (Asesor)
// ============================================

router.get('/conversaciones/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Conversaciones_Asesor!A:F');

    const conversaciones = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const estadoConv = row[4] || '';

      if (!estado || estadoConv === estado) {
        conversaciones.push({
          id: row[0],
          fecha: row[1],
          cliente: row[2],
          whatsapp: row[3],
          estado: estadoConv,
          ultimaActividad: row[5]
        });
      }
    }

    res.json({
      total: conversaciones.length,
      conversaciones
    });

  } catch (error) {
    console.error('❌ Error obteniendo conversaciones:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/conversaciones/:businessId/:conversacionId/mensajes', async (req, res) => {
  try {
    const { businessId, conversacionId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Mensajes!A:F');

    const mensajes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[1] === conversacionId) {
        mensajes.push({
          id: row[0],
          conversacionId: row[1],
          timestamp: row[2],
          tipo: row[3],
          mensaje: row[4],
          de: row[5]
        });
      }
    }

    mensajes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
      conversacionId,
      total: mensajes.length,
      mensajes
    });

  } catch (error) {
    console.error('❌ Error obteniendo mensajes:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/conversaciones/:businessId/:conversacionId', async (req, res) => {
  try {
    const { businessId, conversacionId } = req.params;
    const { estado } = req.body;

    if (!estado) {
      return res.status(400).json({ error: 'Falta campo: estado' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Conversaciones_Asesor!A:E');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === conversacionId) {
        await sheets.updateCell(`Conversaciones_Asesor!E${i + 1}`, estado);

        return res.json({
          success: true,
          conversacionId,
          nuevoEstado: estado
        });
      }
    }

    res.status(404).json({ error: 'Conversación no encontrada' });

  } catch (error) {
    console.error('❌ Error actualizando conversación:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PEDIDOS
// ============================================

router.get('/pedidos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Pedidos!A:R');

    const pedidos = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const estadoPedido = row[9] || '';

      if (estado && estadoPedido !== estado) continue;

      pedidos.push({
        id: row[0],
        fecha: row[1],
        hora: row[2],
        whatsapp: row[3],
        cliente: row[4],
        telefono: row[5],
        direccion: row[6],
        productos: row[7],
        total: parseFloat(row[8]) || 0,
        estado: estadoPedido,
        voucherUrls: row[10],
        observaciones: row[11]
      });
    }

    pedidos.reverse();

    res.json({
      total: pedidos.length,
      pedidos
    });

  } catch (error) {
    console.error('❌ Error obteniendo pedidos:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/pedidos/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { estado, observaciones, notificarCliente } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Pedidos!A:L');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        const updates = [];

        if (estado) {
          updates.push({ range: `Pedidos!J${i + 1}`, value: estado });
        }
        if (observaciones) {
          updates.push({ range: `Pedidos!L${i + 1}`, value: observaciones });
        }

        if (updates.length > 0) {
          await sheets.batchUpdate(updates);
        }

        if (notificarCliente && estado) {
          const whatsapp = new WhatsAppService(negocio.whatsapp);
          const clienteWhatsapp = rows[i][3];

          const mensajesEstado = {
            'CONFIRMADO': `✅ Tu pedido *${pedidoId}* ha sido confirmado. ¡Gracias!`,
            'EN_PREPARACION': `📦 Tu pedido *${pedidoId}* está en preparación.`,
            'ENVIADO': `🚚 Tu pedido *${pedidoId}* ha sido enviado. ¡Pronto llegará!`,
            'ENTREGADO': `✅ Tu pedido *${pedidoId}* ha sido entregado. ¡Gracias por tu compra!`,
            'CANCELADO': `❌ Tu pedido *${pedidoId}* ha sido cancelado.`
          };

          const mensaje = mensajesEstado[estado];
          if (mensaje) {
            await whatsapp.sendMessage(clienteWhatsapp, mensaje);
          }
        }

        return res.json({
          success: true,
          pedidoId,
          nuevoEstado: estado
        });
      }
    }

    res.status(404).json({ error: 'Pedido no encontrado' });

  } catch (error) {
    console.error('❌ Error actualizando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CLIENTES - CRUD COMPLETO
// ============================================

router.get('/clientes/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, departamento, ordenar } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:K');

    let clientes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;

      const cliente = {
        id: row[0] || '',
        whatsapp: row[1] || '',
        nombre: row[2] || '',
        telefono: row[3] || '',
        direccion: row[4] || '',
        fechaRegistro: row[5] || '',
        ultimaCompra: row[6] || '',
        departamento: row[7] || '',
        ciudad: row[8] || '',
        empresa: row[9] || '',
        notas: row[10] || '',
        rowIndex: i + 1
      };

      if (buscar) {
        const searchLower = buscar.toLowerCase();
        const matchNombre = cliente.nombre.toLowerCase().includes(searchLower);
        const matchWhatsapp = cliente.whatsapp.includes(buscar);
        const matchEmpresa = cliente.empresa.toLowerCase().includes(searchLower);
        const matchTelefono = cliente.telefono.includes(buscar);

        if (!matchNombre && !matchWhatsapp && !matchEmpresa && !matchTelefono) continue;
      }

      if (departamento && cliente.departamento !== departamento) continue;

      clientes.push(cliente);
    }

    if (ordenar === 'nombre') {
      clientes.sort((a, b) => a.nombre.localeCompare(b.nombre));
    } else if (ordenar === 'reciente') {
      clientes.sort((a, b) => new Date(b.fechaRegistro) - new Date(a.fechaRegistro));
    } else if (ordenar === 'ultima_compra') {
      clientes.sort((a, b) => new Date(b.ultimaCompra) - new Date(a.ultimaCompra));
    }

    res.json({
      total: clientes.length,
      clientes
    });

  } catch (error) {
    console.error('❌ Error obteniendo clientes:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/clientes/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:K');
    let cliente = null;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        cliente = {
          id: rows[i][0],
          whatsapp: rows[i][1] || '',
          nombre: rows[i][2] || '',
          telefono: rows[i][3] || '',
          direccion: rows[i][4] || '',
          fechaRegistro: rows[i][5] || '',
          ultimaCompra: rows[i][6] || '',
          departamento: rows[i][7] || '',
          ciudad: rows[i][8] || '',
          empresa: rows[i][9] || '',
          notas: rows[i][10] || '',
          rowIndex: i + 1
        };
        break;
      }
    }

    if (!cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const pedidos = await sheets.getPedidosByWhatsapp(cliente.whatsapp);

    res.json({
      cliente,
      pedidos: pedidos.slice(0, 20),
      estadisticas: {
        totalPedidos: pedidos.length,
        totalComprado: pedidos.reduce((sum, p) => sum + p.total, 0),
        pedidosActivos: pedidos.filter(p => !['ENTREGADO', 'CANCELADO'].includes(p.estado)).length
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/clientes/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { whatsapp, nombre, telefono, direccion, departamento, ciudad, empresa, notas } = req.body;

    if (!whatsapp || !nombre) {
      return res.status(400).json({
        error: 'Campos requeridos: whatsapp, nombre'
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const clienteExistente = await sheets.buscarCliente(whatsapp);
    if (clienteExistente) {
      return res.status(400).json({
        error: 'Ya existe un cliente con ese WhatsApp',
        clienteExistente: clienteExistente.id
      });
    }

    const clienteId = `CLI-${Date.now().toString().slice(-6)}`;
    const fechaHoy = new Date().toLocaleDateString('es-PE');

    const valores = [
      clienteId,
      whatsapp.replace(/[^0-9]/g, ''),
      nombre,
      telefono || '',
      direccion || '',
      fechaHoy,
      '',
      departamento || '',
      ciudad || '',
      empresa || '',
      notas || ''
    ];

    await sheets.appendRow('Clientes', valores);

    res.status(201).json({
      success: true,
      mensaje: 'Cliente creado',
      cliente: {
        id: clienteId,
        whatsapp: whatsapp.replace(/[^0-9]/g, ''),
        nombre,
        telefono: telefono || '',
        direccion: direccion || '',
        fechaRegistro: fechaHoy,
        departamento: departamento || '',
        ciudad: ciudad || '',
        empresa: empresa || '',
        notas: notas || ''
      }
    });

  } catch (error) {
    console.error('❌ Error creando cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/clientes/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { nombre, telefono, direccion, departamento, ciudad, empresa, notas, whatsapp } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:K');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        const updates = [];

        if (whatsapp !== undefined) updates.push({ range: `Clientes!B${i + 1}`, value: whatsapp.replace(/[^0-9]/g, '') });
        if (nombre !== undefined) updates.push({ range: `Clientes!C${i + 1}`, value: nombre });
        if (telefono !== undefined) updates.push({ range: `Clientes!D${i + 1}`, value: telefono });
        if (direccion !== undefined) updates.push({ range: `Clientes!E${i + 1}`, value: direccion });
        if (departamento !== undefined) updates.push({ range: `Clientes!H${i + 1}`, value: departamento });
        if (ciudad !== undefined) updates.push({ range: `Clientes!I${i + 1}`, value: ciudad });
        if (empresa !== undefined) updates.push({ range: `Clientes!J${i + 1}`, value: empresa });
        if (notas !== undefined) updates.push({ range: `Clientes!K${i + 1}`, value: notas });

        if (updates.length > 0) {
          await sheets.batchUpdate(updates);
        }

        return res.json({
          success: true,
          mensaje: 'Cliente actualizado',
          clienteId
        });
      }
    }

    res.status(404).json({ error: 'Cliente no encontrado' });

  } catch (error) {
    console.error('❌ Error actualizando cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/clientes/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:B');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        await sheets.updateCell(`Clientes!A${i + 1}`, `${clienteId}_DELETED_${Date.now()}`);

        return res.json({
          success: true,
          mensaje: 'Cliente eliminado',
          clienteId
        });
      }
    }

    res.status(404).json({ error: 'Cliente no encontrado' });

  } catch (error) {
    console.error('❌ Error eliminando cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/clientes/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { clientes } = req.body;

    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de clientes' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const resultados = {
      creados: [],
      existentes: [],
      errores: []
    };

    for (const cli of clientes) {
      try {
        if (!cli.whatsapp || !cli.nombre) {
          resultados.errores.push({ whatsapp: cli.whatsapp, error: 'Falta whatsapp o nombre' });
          continue;
        }

        const whatsappLimpio = cli.whatsapp.replace(/[^0-9]/g, '');
        const existente = await sheets.buscarCliente(whatsappLimpio);

        if (existente) {
          resultados.existentes.push(whatsappLimpio);
          continue;
        }

        const clienteId = `CLI-${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(-2)}`;
        const fechaHoy = new Date().toLocaleDateString('es-PE');

        await sheets.appendRow('Clientes', [
          clienteId,
          whatsappLimpio,
          cli.nombre,
          cli.telefono || '',
          cli.direccion || '',
          fechaHoy,
          '',
          cli.departamento || '',
          cli.ciudad || '',
          cli.empresa || '',
          cli.notas || ''
        ]);

        resultados.creados.push(whatsappLimpio);
      } catch (e) {
        resultados.errores.push({ whatsapp: cli.whatsapp, error: e.message });
      }
    }

    res.json({
      success: true,
      resumen: {
        total: clientes.length,
        creados: resultados.creados.length,
        existentes: resultados.existentes.length,
        errores: resultados.errores.length
      },
      detalles: resultados
    });

  } catch (error) {
    console.error('❌ Error importando clientes:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/clientes/:businessId/:clienteId/mensaje', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { mensaje } = req.body;

    if (!mensaje) {
      return res.status(400).json({ error: 'Campo requerido: mensaje' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:B');
    let whatsappCliente = null;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        whatsappCliente = rows[i][1];
        break;
      }
    }

    if (!whatsappCliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result = await whatsapp.sendMessage(whatsappCliente, mensaje);

    res.json({
      success: true,
      messageId: result.messages?.[0]?.id,
      to: whatsappCliente
    });

  } catch (error) {
    console.error('❌ Error enviando mensaje:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NEGOCIOS
// ============================================

router.get('/negocios', (req, res) => {
  const negocios = negociosService.getAll().map(n => ({
    id: n.id,
    nombre: n.nombre,
    tipo: n.whatsapp.tipo,
    flujo: n.flujo,
    features: n.features
  }));
  res.json(negocios);
});

router.get('/negocios/por-whatsapp/:whatsapp', async (req, res) => {
  try {
    let { whatsapp } = req.params;

    whatsapp = whatsapp.replace(/[^0-9]/g, '');

    if (whatsapp.length === 9) {
      whatsapp = '51' + whatsapp;
    }

    console.log(`🔍 Buscando negocio para WhatsApp: ${whatsapp}`);

    const negocios = negociosService.getAll();

    for (const negocio of negocios) {
      let whatsappAdmin = (negocio.whatsapp?.admin || '').toString().replace(/[^0-9]/g, '');

      if (whatsappAdmin.length === 9) {
        whatsappAdmin = '51' + whatsappAdmin;
      }

      if (whatsappAdmin && whatsappAdmin === whatsapp) {
        console.log(`✅ Negocio encontrado: ${negocio.nombre}`);
        return res.json({
          encontrado: true,
          negocio: {
            id: negocio.id,
            nombre: negocio.nombre,
            flujo: negocio.flujo,
            features: negocio.features,
            whatsappAdmin: whatsappAdmin
          }
        });
      }
    }

    res.json({
      encontrado: false,
      mensaje: 'No se encontró ningún negocio asociado a este número'
    });

  } catch (error) {
    console.error('❌ Error buscando negocio:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/negocios/reload', async (req, res) => {
  try {
    const config = require('../config');
    const masterSheets = new SheetsService(config.google.masterSpreadsheetId);
    await masterSheets.initialize();
    await negociosService.reload(masterSheets);
    res.json({ success: true, count: negociosService.getAll().length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PRODUCTOS - CON PAGINACIÓN
// ============================================

/**
 * GET /api/productos/:businessId
 * 
 * Listar productos con paginación y filtros
 * Query params: 
 *   - estado: filtrar por estado
 *   - buscar: búsqueda por nombre/código
 *   - ordenar: precio_asc, precio_desc, stock, nombre
 *   - pagina: número de página (default: 1)
 *   - limite: productos por página (default: 20)
 */
router.get('/productos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, buscar, ordenar, pagina = 1, limite = 20 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    let productos = await sheets.getProductos(estado || null);

    // Filtrar por búsqueda
    if (buscar) {
      const searchLower = buscar.toLowerCase();
      productos = productos.filter(p =>
        p.nombre.toLowerCase().includes(searchLower) ||
        p.codigo.toLowerCase().includes(searchLower) ||
        (p.descripcion || '').toLowerCase().includes(searchLower)
      );
    }

    // Invertir orden (más recientes primero - los últimos agregados a la hoja)
    productos.reverse();

    // Ordenar si se especifica
    if (ordenar === 'precio_asc') {
      productos.sort((a, b) => a.precio - b.precio);
    } else if (ordenar === 'precio_desc') {
      productos.sort((a, b) => b.precio - a.precio);
    } else if (ordenar === 'stock') {
      productos.sort((a, b) => b.disponible - a.disponible);
    } else if (ordenar === 'nombre') {
      productos.sort((a, b) => a.nombre.localeCompare(b.nombre));
    }

    // Paginación
    const total = productos.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 20;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;
    const fin = inicio + limiteNum;

    const productosPaginados = productos.slice(inicio, fin);

    res.json({
      total,
      pagina: paginaNum,
      limite: limiteNum,
      totalPaginas,
      hayMas: paginaNum < totalPaginas,
      productos: productosPaginados
    });

  } catch (error) {
    console.error('❌ Error obteniendo productos:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const productos = await sheets.getProductos();
    const producto = productos.find(p => p.codigo === codigo);

    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    res.json(producto);

  } catch (error) {
    console.error('❌ Error obteniendo producto:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { codigo, nombre, descripcion, precio, stock, imagenUrl, estado, categoria } = req.body;

    if (!codigo || !nombre || precio === undefined || stock === undefined) {
      return res.status(400).json({
        error: 'Campos requeridos: codigo, nombre, precio, stock'
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const productos = await sheets.getProductos();
    if (productos.find(p => p.codigo === codigo)) {
      return res.status(400).json({ error: 'Ya existe un producto con ese código' });
    }

    const valores = [
      codigo,
      nombre,
      descripcion || '',
      precio,
      stock,
      0,
      imagenUrl || '',
      estado || 'ACTIVO',
      categoria || ''
    ];

    await sheets.appendRow('Inventario', valores);

    res.status(201).json({
      success: true,
      mensaje: 'Producto creado',
      producto: {
        codigo,
        nombre,
        descripcion: descripcion || '',
        precio,
        stock,
        stockReservado: 0,
        imagenUrl: imagenUrl || '',
        estado: estado || 'ACTIVO',
        categoria: categoria || '',
        disponible: stock
      }
    });

  } catch (error) {
    console.error('❌ Error creando producto:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { nombre, descripcion, precio, stock, imagenUrl, estado, categoria } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Inventario!A:I');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === codigo) {
        const updates = [];

        if (nombre !== undefined) updates.push({ range: `Inventario!B${i + 1}`, value: nombre });
        if (descripcion !== undefined) updates.push({ range: `Inventario!C${i + 1}`, value: descripcion });
        if (precio !== undefined) updates.push({ range: `Inventario!D${i + 1}`, value: precio });
        if (stock !== undefined) updates.push({ range: `Inventario!E${i + 1}`, value: stock });
        if (imagenUrl !== undefined) updates.push({ range: `Inventario!G${i + 1}`, value: imagenUrl });
        if (estado !== undefined) updates.push({ range: `Inventario!H${i + 1}`, value: estado });
        if (categoria !== undefined) updates.push({ range: `Inventario!I${i + 1}`, value: categoria });

        if (updates.length > 0) {
          await sheets.batchUpdate(updates);
        }

        const productosActualizados = await sheets.getProductos();
        const productoActualizado = productosActualizados.find(p => p.codigo === codigo);

        return res.json({
          success: true,
          mensaje: 'Producto actualizado',
          producto: productoActualizado
        });
      }
    }

    res.status(404).json({ error: 'Producto no encontrado' });

  } catch (error) {
    console.error('❌ Error actualizando producto:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { force } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Inventario!A:H');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === codigo) {

        if (force === 'true') {
          await sheets.updateCell(`Inventario!H${i + 1}`, 'ELIMINADO');
          await sheets.updateCell(`Inventario!A${i + 1}`, `${codigo}_DELETED_${Date.now()}`);
        } else {
          await sheets.updateCell(`Inventario!H${i + 1}`, 'INACTIVO');
        }

        return res.json({
          success: true,
          mensaje: force === 'true' ? 'Producto eliminado permanentemente' : 'Producto desactivado',
          codigo
        });
      }
    }

    res.status(404).json({ error: 'Producto no encontrado' });

  } catch (error) {
    console.error('❌ Error eliminando producto:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId/:codigo/stock', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { cantidad, operacion, motivo } = req.body;

    if (cantidad === undefined || !operacion) {
      return res.status(400).json({
        error: 'Campos requeridos: cantidad, operacion (agregar|restar|establecer)'
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Inventario!A:F');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === codigo) {
        const stockActual = parseInt(rows[i][4]) || 0;
        let nuevoStock;

        switch (operacion) {
          case 'agregar':
            nuevoStock = stockActual + parseInt(cantidad);
            break;
          case 'restar':
            nuevoStock = Math.max(0, stockActual - parseInt(cantidad));
            break;
          case 'establecer':
            nuevoStock = parseInt(cantidad);
            break;
          default:
            return res.status(400).json({ error: 'Operación inválida' });
        }

        await sheets.updateCell(`Inventario!E${i + 1}`, nuevoStock);

        try {
          await sheets.appendRow('MovimientosStock', [
            `MOV-${Date.now()}`,
            new Date().toISOString(),
            codigo,
            rows[i][1],
            operacion,
            cantidad,
            stockActual,
            nuevoStock,
            motivo || ''
          ]);
        } catch (e) {
          // Hoja no existe, ignorar
        }

        return res.json({
          success: true,
          codigo,
          stockAnterior: stockActual,
          stockNuevo: nuevoStock,
          operacion,
          cantidad: parseInt(cantidad)
        });
      }
    }

    res.status(404).json({ error: 'Producto no encontrado' });

  } catch (error) {
    console.error('❌ Error ajustando stock:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/productos/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { productos } = req.body;

    if (!productos || !Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de productos' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const existentes = await sheets.getProductos();
    const codigosExistentes = new Set(existentes.map(p => p.codigo));

    const resultados = {
      creados: [],
      actualizados: [],
      errores: []
    };

    for (const prod of productos) {
      try {
        if (!prod.codigo || !prod.nombre) {
          resultados.errores.push({ codigo: prod.codigo, error: 'Falta codigo o nombre' });
          continue;
        }

        if (codigosExistentes.has(prod.codigo)) {
          const rows = await sheets.getRows(negocio.spreadsheetId, 'Inventario!A:I');
          for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === prod.codigo) {
              const updates = [];
              if (prod.nombre) updates.push({ range: `Inventario!B${i + 1}`, value: prod.nombre });
              if (prod.precio !== undefined) updates.push({ range: `Inventario!D${i + 1}`, value: prod.precio });
              if (prod.stock !== undefined) updates.push({ range: `Inventario!E${i + 1}`, value: prod.stock });
              if (updates.length > 0) await sheets.batchUpdate(updates);
              break;
            }
          }
          resultados.actualizados.push(prod.codigo);
        } else {
          await sheets.appendRow('Inventario', [
            prod.codigo,
            prod.nombre,
            prod.descripcion || '',
            prod.precio || 0,
            prod.stock || 0,
            0,
            prod.imagenUrl || '',
            prod.estado || 'ACTIVO',
            prod.categoria || ''
          ]);
          resultados.creados.push(prod.codigo);
          codigosExistentes.add(prod.codigo);
        }
      } catch (e) {
        resultados.errores.push({ codigo: prod.codigo, error: e.message });
      }
    }

    res.json({
      success: true,
      resumen: {
        total: productos.length,
        creados: resultados.creados.length,
        actualizados: resultados.actualizados.length,
        errores: resultados.errores.length
      },
      detalles: resultados
    });

  } catch (error) {
    console.error('❌ Error importando productos:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
