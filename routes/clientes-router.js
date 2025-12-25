/**
 * CLIENTES ROUTER - Estructura extendida
 * 
 * Columnas en Google Sheets (Clientes):
 * A: ID
 * B: WhatsApp
 * C: NombreNegocio (empresa/cafetería)
 * D: NombreResponsable (persona de contacto)
 * E: Telefono
 * F: Email
 * G: Direccion
 * H: Departamento
 * I: Ciudad
 * J: FechaRegistro
 * K: UltimaCompra
 * L: TotalPedidos (calculado)
 * M: TotalComprado (calculado - S/)
 * N: TotalKg (calculado)
 * O: Notas
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');

/**
 * GET /api/clientes/:businessId
 * Listar clientes con estructura extendida
 */
router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, departamento, ordenar, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:O');

    let clientes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0] || row[0].includes('_DELETED')) continue;

      const cliente = {
        id: row[0] || '',
        whatsapp: row[1] || '',
        nombreNegocio: row[2] || '',
        nombreResponsable: row[3] || '',
        telefono: row[4] || '',
        email: row[5] || '',
        direccion: row[6] || '',
        departamento: row[7] || '',
        ciudad: row[8] || '',
        fechaRegistro: row[9] || '',
        ultimaCompra: row[10] || '',
        totalPedidos: parseInt(row[11]) || 0,
        totalComprado: parseFloat(row[12]) || 0,
        totalKg: parseFloat(row[13]) || 0,
        notas: row[14] || '',
        rowIndex: i + 1
      };

      // Filtrar por búsqueda
      if (buscar) {
        const searchLower = buscar.toLowerCase();
        const matchNegocio = cliente.nombreNegocio.toLowerCase().includes(searchLower);
        const matchResponsable = cliente.nombreResponsable.toLowerCase().includes(searchLower);
        const matchWhatsapp = cliente.whatsapp.includes(buscar);
        const matchTelefono = cliente.telefono.includes(buscar);
        const matchEmail = cliente.email.toLowerCase().includes(searchLower);

        if (!matchNegocio && !matchResponsable && !matchWhatsapp && !matchTelefono && !matchEmail) continue;
      }

      if (departamento && cliente.departamento !== departamento) continue;

      clientes.push(cliente);
    }

    // Ordenar
    if (ordenar === 'nombre') {
      clientes.sort((a, b) => a.nombreNegocio.localeCompare(b.nombreNegocio));
    } else if (ordenar === 'reciente') {
      clientes.sort((a, b) => new Date(b.fechaRegistro) - new Date(a.fechaRegistro));
    } else if (ordenar === 'ultima_compra') {
      clientes.sort((a, b) => new Date(b.ultimaCompra || 0) - new Date(a.ultimaCompra || 0));
    } else if (ordenar === 'total_comprado') {
      clientes.sort((a, b) => b.totalComprado - a.totalComprado);
    } else {
      // Por defecto: más recientes primero
      clientes.reverse();
    }

    // Paginación
    const total = clientes.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 50;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;
    const clientesPaginados = clientes.slice(inicio, inicio + limiteNum);

    res.json({
      total,
      pagina: paginaNum,
      totalPaginas,
      hayMas: paginaNum < totalPaginas,
      clientes: clientesPaginados
    });

  } catch (error) {
    console.error('❌ Error obteniendo clientes:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/clientes/:businessId/:clienteId
 * Obtener detalle de un cliente con historial de pedidos
 */
router.get('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:O');
    let cliente = null;
    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        rowIndex = i + 1;
        cliente = {
          id: rows[i][0],
          whatsapp: rows[i][1] || '',
          nombreNegocio: rows[i][2] || '',
          nombreResponsable: rows[i][3] || '',
          telefono: rows[i][4] || '',
          email: rows[i][5] || '',
          direccion: rows[i][6] || '',
          departamento: rows[i][7] || '',
          ciudad: rows[i][8] || '',
          fechaRegistro: rows[i][9] || '',
          ultimaCompra: rows[i][10] || '',
          totalPedidos: parseInt(rows[i][11]) || 0,
          totalComprado: parseFloat(rows[i][12]) || 0,
          totalKg: parseFloat(rows[i][13]) || 0,
          notas: rows[i][14] || '',
          rowIndex
        };
        break;
      }
    }

    if (!cliente) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Obtener pedidos del cliente
    let pedidos = [];
    try {
      pedidos = await sheets.getPedidosByWhatsapp(cliente.whatsapp);
    } catch (e) {
      // Sin pedidos
    }

    res.json({
      cliente,
      pedidos: pedidos.slice(0, 50),
      estadisticas: {
        totalPedidos: pedidos.length,
        totalComprado: pedidos.reduce((sum, p) => sum + (p.total || 0), 0),
        pedidosActivos: pedidos.filter(p => !['ENTREGADO', 'CANCELADO'].includes(p.estado)).length
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/clientes/:businessId
 * Crear nuevo cliente con estructura extendida
 */
router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { 
      whatsapp, 
      nombreNegocio, 
      nombreResponsable, 
      telefono, 
      email,
      direccion, 
      departamento, 
      ciudad, 
      notas 
    } = req.body;

    // Validaciones
    if (!whatsapp) {
      return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    }

    if (!nombreNegocio && !nombreResponsable) {
      return res.status(400).json({ error: 'Se requiere al menos nombreNegocio o nombreResponsable' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // Verificar que el whatsapp no exista
    const whatsappLimpio = whatsapp.replace(/[^0-9]/g, '');
    const clienteExistente = await sheets.buscarCliente(whatsappLimpio);
    if (clienteExistente) {
      return res.status(400).json({
        error: 'Ya existe un cliente con ese WhatsApp',
        clienteExistente: clienteExistente.id
      });
    }

    const clienteId = `CLI-${Date.now().toString().slice(-6)}`;
    const fechaHoy = new Date().toLocaleDateString('es-PE');

    // Estructura: ID, WhatsApp, NombreNegocio, NombreResponsable, Telefono, Email, Direccion, Depto, Ciudad, FechaReg, UltimaCompra, TotalPedidos, TotalComprado, TotalKg, Notas
    const valores = [
      clienteId,
      whatsappLimpio,
      nombreNegocio || '',
      nombreResponsable || '',
      telefono || '',
      email || '',
      direccion || '',
      departamento || '',
      ciudad || '',
      fechaHoy,
      '', // UltimaCompra
      0,  // TotalPedidos
      0,  // TotalComprado
      0,  // TotalKg
      notas || ''
    ];

    await sheets.appendRow('Clientes', valores);

    res.status(201).json({
      success: true,
      mensaje: 'Cliente creado',
      cliente: {
        id: clienteId,
        whatsapp: whatsappLimpio,
        nombreNegocio: nombreNegocio || '',
        nombreResponsable: nombreResponsable || '',
        telefono: telefono || '',
        email: email || '',
        direccion: direccion || '',
        departamento: departamento || '',
        ciudad: ciudad || '',
        fechaRegistro: fechaHoy,
        notas: notas || ''
      }
    });

  } catch (error) {
    console.error('❌ Error creando cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/clientes/:businessId/:clienteId
 * Actualizar cliente existente
 */
router.put('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { 
      whatsapp,
      nombreNegocio, 
      nombreResponsable, 
      telefono, 
      email,
      direccion, 
      departamento, 
      ciudad, 
      notas 
    } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:O');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        const updates = [];

        if (whatsapp !== undefined) updates.push({ range: `Clientes!B${i + 1}`, value: whatsapp.replace(/[^0-9]/g, '') });
        if (nombreNegocio !== undefined) updates.push({ range: `Clientes!C${i + 1}`, value: nombreNegocio });
        if (nombreResponsable !== undefined) updates.push({ range: `Clientes!D${i + 1}`, value: nombreResponsable });
        if (telefono !== undefined) updates.push({ range: `Clientes!E${i + 1}`, value: telefono });
        if (email !== undefined) updates.push({ range: `Clientes!F${i + 1}`, value: email });
        if (direccion !== undefined) updates.push({ range: `Clientes!G${i + 1}`, value: direccion });
        if (departamento !== undefined) updates.push({ range: `Clientes!H${i + 1}`, value: departamento });
        if (ciudad !== undefined) updates.push({ range: `Clientes!I${i + 1}`, value: ciudad });
        if (notas !== undefined) updates.push({ range: `Clientes!O${i + 1}`, value: notas });

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

/**
 * DELETE /api/clientes/:businessId/:clienteId
 */
router.delete('/:businessId/:clienteId', async (req, res) => {
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

/**
 * POST /api/clientes/:businessId/importar
 * Importar clientes con estructura extendida
 */
router.post('/:businessId/importar', async (req, res) => {
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
        if (!cli.whatsapp) {
          resultados.errores.push({ whatsapp: cli.whatsapp, error: 'Falta whatsapp' });
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
          cli.nombreNegocio || cli.empresa || cli.nombre || '',
          cli.nombreResponsable || '',
          cli.telefono || '',
          cli.email || '',
          cli.direccion || '',
          cli.departamento || '',
          cli.ciudad || '',
          fechaHoy,
          cli.ultimaCompra || '',
          cli.totalPedidos || 0,
          cli.totalComprado || 0,
          cli.totalKg || 0,
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

/**
 * POST /api/clientes/:businessId/:clienteId/mensaje
 * Enviar mensaje directo a un cliente
 */
router.post('/:businessId/:clienteId/mensaje', async (req, res) => {
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

/**
 * POST /api/clientes/:businessId/:clienteId/actualizar-stats
 * Recalcular estadísticas del cliente basado en pedidos
 */
router.post('/:businessId/:clienteId/actualizar-stats', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // Buscar cliente
    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:O');
    let clienteRow = -1;
    let whatsapp = '';

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        clienteRow = i + 1;
        whatsapp = rows[i][1];
        break;
      }
    }

    if (clienteRow === -1) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Obtener pedidos del cliente
    let pedidos = [];
    try {
      pedidos = await sheets.getPedidosByWhatsapp(whatsapp);
    } catch (e) {
      // Sin pedidos
    }

    // Calcular estadísticas
    const totalPedidos = pedidos.length;
    const totalComprado = pedidos.reduce((sum, p) => sum + (p.total || 0), 0);
    
    // Calcular total Kg (si los productos tienen peso)
    let totalKg = 0;
    for (const pedido of pedidos) {
      // Intentar extraer kg del campo productos
      const productos = pedido.productos || '';
      const kgMatch = productos.match(/(\d+(?:\.\d+)?)\s*kg/gi);
      if (kgMatch) {
        for (const match of kgMatch) {
          const kg = parseFloat(match);
          if (!isNaN(kg)) totalKg += kg;
        }
      }
    }

    // Última compra
    const ultimaCompra = pedidos.length > 0 ? pedidos[0].fecha : '';

    // Actualizar en sheets
    await sheets.batchUpdate([
      { range: `Clientes!K${clienteRow}`, value: ultimaCompra },
      { range: `Clientes!L${clienteRow}`, value: totalPedidos },
      { range: `Clientes!M${clienteRow}`, value: totalComprado },
      { range: `Clientes!N${clienteRow}`, value: totalKg }
    ]);

    res.json({
      success: true,
      stats: {
        totalPedidos,
        totalComprado,
        totalKg,
        ultimaCompra
      }
    });

  } catch (error) {
    console.error('❌ Error actualizando stats:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
