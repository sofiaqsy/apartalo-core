/**
 * CLIENTES ROUTER - Estructura completa para Finca Rosal
 * 
 * Columnas en Google Sheets (Clientes):
 * A: ID
 * B: WhatsApp
 * C: NombreNegocio (cafetería/empresa)
 * D: NombreResponsable (persona de contacto)
 * E: Telefono
 * F: Email
 * G: Direccion
 * H: Departamento
 * I: Distrito/Ciudad
 * J: FechaRegistro
 * K: UltimaCompra
 * L: TotalPedidos
 * M: TotalComprado (S/)
 * N: TotalKg
 * O: TipoEnvio (NACIONAL/LOCAL)
 * P: EmpresaEnvio (Shalom, Olva, etc)
 * Q: LocalEnvio (agencia/sucursal)
 * R: DireccionEnvio
 * S: DistritoEnvio
 * T: DepartamentoEnvio
 * U: Notas
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');

/**
 * GET /api/clientes/:businessId
 * Listar clientes con estructura completa
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

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:U');

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
        distrito: row[8] || '',
        fechaRegistro: row[9] || '',
        ultimaCompra: row[10] || '',
        totalPedidos: parseInt(row[11]) || 0,
        totalComprado: parseFloat(row[12]) || 0,
        totalKg: parseFloat(row[13]) || 0,
        // Datos de envío homologados
        tipoEnvio: row[14] || '',
        empresaEnvio: row[15] || '',
        localEnvio: row[16] || '',
        direccionEnvio: row[17] || '',
        distritoEnvio: row[18] || '',
        departamentoEnvio: row[19] || '',
        notas: row[20] || '',
        rowIndex: i + 1
      };

      // Filtrar por búsqueda
      if (buscar) {
        const searchLower = buscar.toLowerCase();
        const matchNegocio = cliente.nombreNegocio.toLowerCase().includes(searchLower);
        const matchResponsable = cliente.nombreResponsable.toLowerCase().includes(searchLower);
        const matchWhatsapp = cliente.whatsapp.includes(buscar);
        const matchTelefono = cliente.telefono.includes(buscar);
        const matchEmail = (cliente.email || '').toLowerCase().includes(searchLower);
        const matchEmpresa = (cliente.empresaEnvio || '').toLowerCase().includes(searchLower);

        if (!matchNegocio && !matchResponsable && !matchWhatsapp && !matchTelefono && !matchEmail && !matchEmpresa) continue;
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

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:U');
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
          distrito: rows[i][8] || '',
          fechaRegistro: rows[i][9] || '',
          ultimaCompra: rows[i][10] || '',
          totalPedidos: parseInt(rows[i][11]) || 0,
          totalComprado: parseFloat(rows[i][12]) || 0,
          totalKg: parseFloat(rows[i][13]) || 0,
          tipoEnvio: rows[i][14] || '',
          empresaEnvio: rows[i][15] || '',
          localEnvio: rows[i][16] || '',
          direccionEnvio: rows[i][17] || '',
          distritoEnvio: rows[i][18] || '',
          departamentoEnvio: rows[i][19] || '',
          notas: rows[i][20] || '',
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
 * Crear nuevo cliente con estructura completa
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
      distrito,
      // Datos de envío
      tipoEnvio,
      empresaEnvio,
      localEnvio,
      direccionEnvio,
      distritoEnvio,
      departamentoEnvio,
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
    const whatsappLimpio = whatsapp.replace(/[^0-9+]/g, '');
    
    // Buscar si ya existe
    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:B');
    for (let i = 1; i < rows.length; i++) {
      const existingWa = (rows[i][1] || '').replace(/[^0-9]/g, '');
      const newWa = whatsappLimpio.replace(/[^0-9]/g, '');
      if (existingWa === newWa && !rows[i][0].includes('_DELETED')) {
        return res.status(400).json({
          error: 'Ya existe un cliente con ese WhatsApp',
          clienteExistente: rows[i][0]
        });
      }
    }

    const clienteId = `CLI-${Date.now().toString().slice(-6)}`;
    const fechaHoy = new Date().toLocaleDateString('es-PE');

    // Estructura completa: 21 columnas (A-U)
    const valores = [
      clienteId,                    // A: ID
      whatsappLimpio,               // B: WhatsApp
      nombreNegocio || '',          // C: NombreNegocio
      nombreResponsable || '',      // D: NombreResponsable
      telefono || '',               // E: Telefono
      email || '',                  // F: Email
      direccion || '',              // G: Direccion
      departamento || '',           // H: Departamento
      distrito || '',               // I: Distrito
      fechaHoy,                     // J: FechaRegistro
      '',                           // K: UltimaCompra
      0,                            // L: TotalPedidos
      0,                            // M: TotalComprado
      0,                            // N: TotalKg
      tipoEnvio || '',              // O: TipoEnvio
      empresaEnvio || '',           // P: EmpresaEnvio
      localEnvio || '',             // Q: LocalEnvio
      direccionEnvio || '',         // R: DireccionEnvio
      distritoEnvio || '',          // S: DistritoEnvio
      departamentoEnvio || '',      // T: DepartamentoEnvio
      notas || ''                   // U: Notas
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
        distrito: distrito || '',
        fechaRegistro: fechaHoy,
        tipoEnvio: tipoEnvio || '',
        empresaEnvio: empresaEnvio || '',
        localEnvio: localEnvio || '',
        direccionEnvio: direccionEnvio || '',
        distritoEnvio: distritoEnvio || '',
        departamentoEnvio: departamentoEnvio || '',
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
      distrito,
      tipoEnvio,
      empresaEnvio,
      localEnvio,
      direccionEnvio,
      distritoEnvio,
      departamentoEnvio,
      notas 
    } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:U');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        const updates = [];
        const rowNum = i + 1;

        if (whatsapp !== undefined) updates.push({ range: `Clientes!B${rowNum}`, value: whatsapp.replace(/[^0-9+]/g, '') });
        if (nombreNegocio !== undefined) updates.push({ range: `Clientes!C${rowNum}`, value: nombreNegocio });
        if (nombreResponsable !== undefined) updates.push({ range: `Clientes!D${rowNum}`, value: nombreResponsable });
        if (telefono !== undefined) updates.push({ range: `Clientes!E${rowNum}`, value: telefono });
        if (email !== undefined) updates.push({ range: `Clientes!F${rowNum}`, value: email });
        if (direccion !== undefined) updates.push({ range: `Clientes!G${rowNum}`, value: direccion });
        if (departamento !== undefined) updates.push({ range: `Clientes!H${rowNum}`, value: departamento });
        if (distrito !== undefined) updates.push({ range: `Clientes!I${rowNum}`, value: distrito });
        if (tipoEnvio !== undefined) updates.push({ range: `Clientes!O${rowNum}`, value: tipoEnvio });
        if (empresaEnvio !== undefined) updates.push({ range: `Clientes!P${rowNum}`, value: empresaEnvio });
        if (localEnvio !== undefined) updates.push({ range: `Clientes!Q${rowNum}`, value: localEnvio });
        if (direccionEnvio !== undefined) updates.push({ range: `Clientes!R${rowNum}`, value: direccionEnvio });
        if (distritoEnvio !== undefined) updates.push({ range: `Clientes!S${rowNum}`, value: distritoEnvio });
        if (departamentoEnvio !== undefined) updates.push({ range: `Clientes!T${rowNum}`, value: departamentoEnvio });
        if (notas !== undefined) updates.push({ range: `Clientes!U${rowNum}`, value: notas });

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
 * Importar clientes con estructura completa
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

    // Obtener clientes existentes
    const existingRows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:B');
    const existingWhatsapps = new Set();
    for (let i = 1; i < existingRows.length; i++) {
      if (!existingRows[i][0].includes('_DELETED')) {
        const wa = (existingRows[i][1] || '').replace(/[^0-9]/g, '');
        if (wa) existingWhatsapps.add(wa);
      }
    }

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
        
        if (existingWhatsapps.has(whatsappLimpio)) {
          resultados.existentes.push(whatsappLimpio);
          continue;
        }

        const clienteId = `CLI-${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(-2)}`;
        const fechaHoy = new Date().toLocaleDateString('es-PE');

        await sheets.appendRow('Clientes', [
          clienteId,
          whatsappLimpio,
          cli.nombreNegocio || cli.empresa || cli.nombre || '',
          cli.nombreResponsable || cli.responsable || '',
          cli.telefono || '',
          cli.email || '',
          cli.direccion || '',
          cli.departamento || '',
          cli.distrito || cli.ciudad || '',
          fechaHoy,
          cli.ultimaCompra || '',
          cli.totalPedidos || 0,
          cli.totalComprado || 0,
          cli.totalKg || 0,
          cli.tipoEnvio || '',
          cli.empresaEnvio || '',
          cli.localEnvio || '',
          cli.direccionEnvio || '',
          cli.distritoEnvio || '',
          cli.departamentoEnvio || '',
          cli.notas || ''
        ]);

        resultados.creados.push(whatsappLimpio);
        existingWhatsapps.add(whatsappLimpio);
        
        // Pequeña pausa para evitar rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
        
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
    const rows = await sheets.getRows(negocio.spreadsheetId, 'Clientes!A:U');
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
    
    // Calcular total Kg
    let totalKg = 0;
    for (const pedido of pedidos) {
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
