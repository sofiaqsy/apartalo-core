/**
 * CLIENTES ROUTER - Estructura completa
 * FIX: getRows() solo recibe 'range' (sheets-service usa this.spreadsheetId internamente)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');

router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, departamento, estado, ordenar, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Clientes!A:V');

    let clientes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0] || row[0].includes('_DELETED')) continue;

      const cliente = {
        id: row[0] || '', whatsapp: row[1] || '', nombreNegocio: row[2] || '', nombreResponsable: row[3] || '',
        telefono: row[4] || '', email: row[5] || '', direccion: row[6] || '', departamento: row[7] || '',
        distrito: row[8] || '', fechaRegistro: row[9] || '', ultimaCompra: row[10] || '',
        totalPedidos: parseInt(row[11]) || 0, totalComprado: parseFloat(row[12]) || 0, totalKg: parseFloat(row[13]) || 0,
        estado: row[14] || 'ACTIVO', tipoEnvio: row[15] || '', empresaEnvio: row[16] || '', localEnvio: row[17] || '',
        direccionEnvio: row[18] || '', distritoEnvio: row[19] || '', departamentoEnvio: row[20] || '', notas: row[21] || '', rowIndex: i + 1
      };

      if (estado && cliente.estado !== estado) continue;
      if (buscar) {
        const s = buscar.toLowerCase();
        if (!cliente.nombreNegocio.toLowerCase().includes(s) && !cliente.nombreResponsable.toLowerCase().includes(s) && !cliente.whatsapp.includes(buscar) && !cliente.telefono.includes(buscar) && !(cliente.email || '').toLowerCase().includes(s) && !(cliente.empresaEnvio || '').toLowerCase().includes(s)) continue;
      }
      if (departamento && cliente.departamento !== departamento) continue;

      clientes.push(cliente);
    }

    if (ordenar === 'nombre') clientes.sort((a, b) => a.nombreNegocio.localeCompare(b.nombreNegocio));
    else if (ordenar === 'reciente') clientes.sort((a, b) => new Date(b.fechaRegistro) - new Date(a.fechaRegistro));
    else if (ordenar === 'ultima_compra') clientes.sort((a, b) => new Date(b.ultimaCompra || 0) - new Date(a.ultimaCompra || 0));
    else if (ordenar === 'total_comprado') clientes.sort((a, b) => b.totalComprado - a.totalComprado);
    else clientes.reverse();

    const total = clientes.length;
    const paginaNum = parseInt(pagina) || 1;
    const limiteNum = parseInt(limite) || 50;
    const totalPaginas = Math.ceil(total / limiteNum);
    const inicio = (paginaNum - 1) * limiteNum;

    res.json({ total, pagina: paginaNum, totalPaginas, hayMas: paginaNum < totalPaginas, clientes: clientes.slice(inicio, inicio + limiteNum) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Clientes!A:V');
    let cliente = null;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        cliente = {
          id: rows[i][0], whatsapp: rows[i][1] || '', nombreNegocio: rows[i][2] || '', nombreResponsable: rows[i][3] || '',
          telefono: rows[i][4] || '', email: rows[i][5] || '', direccion: rows[i][6] || '', departamento: rows[i][7] || '',
          distrito: rows[i][8] || '', fechaRegistro: rows[i][9] || '', ultimaCompra: rows[i][10] || '',
          totalPedidos: parseInt(rows[i][11]) || 0, totalComprado: parseFloat(rows[i][12]) || 0, totalKg: parseFloat(rows[i][13]) || 0,
          estado: rows[i][14] || 'ACTIVO', tipoEnvio: rows[i][15] || '', empresaEnvio: rows[i][16] || '', localEnvio: rows[i][17] || '',
          direccionEnvio: rows[i][18] || '', distritoEnvio: rows[i][19] || '', departamentoEnvio: rows[i][20] || '', notas: rows[i][21] || '', rowIndex: i + 1
        };
        break;
      }
    }

    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    let pedidos = [];
    try { pedidos = await sheets.getPedidosByWhatsapp(cliente.whatsapp); } catch (e) {}

    res.json({
      cliente, pedidos: pedidos.slice(0, 50),
      estadisticas: { totalPedidos: pedidos.length, totalComprado: pedidos.reduce((sum, p) => sum + (p.total || 0), 0), pedidosActivos: pedidos.filter(p => !['ENTREGADO', 'CANCELADO'].includes(p.estado)).length }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { whatsapp, nombreNegocio, nombreResponsable, telefono, email, direccion, departamento, distrito, estado, tipoEnvio, empresaEnvio, localEnvio, direccionEnvio, distritoEnvio, departamentoEnvio, notas } = req.body;

    if (!whatsapp) return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    if (!nombreNegocio && !nombreResponsable) return res.status(400).json({ error: 'Se requiere al menos nombreNegocio o nombreResponsable' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const whatsappLimpio = whatsapp.replace(/[^0-9+]/g, '');
    const rows = await sheets.getRows('Clientes!A:B');
    for (let i = 1; i < rows.length; i++) {
      const existingWa = (rows[i][1] || '').replace(/[^0-9]/g, '');
      const newWa = whatsappLimpio.replace(/[^0-9]/g, '');
      if (existingWa === newWa && !rows[i][0].includes('_DELETED')) {
        return res.status(400).json({ error: 'Ya existe un cliente con ese WhatsApp', clienteExistente: rows[i][0] });
      }
    }

    const clienteId = `CLI-${Date.now().toString().slice(-6)}`;
    const fechaHoy = new Date().toLocaleDateString('es-PE');

    const valores = [
      clienteId, whatsappLimpio, nombreNegocio || '', nombreResponsable || '', telefono || '', email || '',
      direccion || '', departamento || '', distrito || '', fechaHoy, '', 0, 0, 0, estado || 'ACTIVO',
      tipoEnvio || '', empresaEnvio || '', localEnvio || '', direccionEnvio || '', distritoEnvio || '', departamentoEnvio || '', notas || ''
    ];

    await sheets.appendRow('Clientes', valores);

    res.status(201).json({ success: true, mensaje: 'Cliente creado', cliente: { id: clienteId, whatsapp: whatsappLimpio, nombreNegocio: nombreNegocio || '', nombreResponsable: nombreResponsable || '', fechaRegistro: fechaHoy, estado: estado || 'ACTIVO' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { whatsapp, nombreNegocio, nombreResponsable, telefono, email, direccion, departamento, distrito, estado, tipoEnvio, empresaEnvio, localEnvio, direccionEnvio, distritoEnvio, departamentoEnvio, notas } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Clientes!A:V');

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
        if (estado !== undefined) updates.push({ range: `Clientes!O${rowNum}`, value: estado });
        if (tipoEnvio !== undefined) updates.push({ range: `Clientes!P${rowNum}`, value: tipoEnvio });
        if (empresaEnvio !== undefined) updates.push({ range: `Clientes!Q${rowNum}`, value: empresaEnvio });
        if (localEnvio !== undefined) updates.push({ range: `Clientes!R${rowNum}`, value: localEnvio });
        if (direccionEnvio !== undefined) updates.push({ range: `Clientes!S${rowNum}`, value: direccionEnvio });
        if (distritoEnvio !== undefined) updates.push({ range: `Clientes!T${rowNum}`, value: distritoEnvio });
        if (departamentoEnvio !== undefined) updates.push({ range: `Clientes!U${rowNum}`, value: departamentoEnvio });
        if (notas !== undefined) updates.push({ range: `Clientes!V${rowNum}`, value: notas });

        if (updates.length > 0) await sheets.batchUpdate(updates);
        return res.json({ success: true, mensaje: 'Cliente actualizado', clienteId });
      }
    }

    res.status(404).json({ error: 'Cliente no encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

router.post('/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { clientes } = req.body;
    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) return res.status(400).json({ error: 'Se requiere array de clientes' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const existingRows = await sheets.getRows('Clientes!A:B');
    const existingWhatsapps = new Set();
    for (let i = 1; i < existingRows.length; i++) {
      if (!existingRows[i][0].includes('_DELETED')) {
        const wa = (existingRows[i][1] || '').replace(/[^0-9]/g, '');
        if (wa) existingWhatsapps.add(wa);
      }
    }

    const resultados = { creados: [], existentes: [], errores: [] };

    for (const cli of clientes) {
      try {
        if (!cli.whatsapp) { resultados.errores.push({ whatsapp: cli.whatsapp, error: 'Falta whatsapp' }); continue; }
        const whatsappLimpio = cli.whatsapp.replace(/[^0-9]/g, '');
        if (existingWhatsapps.has(whatsappLimpio)) { resultados.existentes.push(whatsappLimpio); continue; }

        const clienteId = `CLI-${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(-2)}`;
        const fechaHoy = new Date().toLocaleDateString('es-PE');

        await sheets.appendRow('Clientes', [
          clienteId, whatsappLimpio, cli.nombreNegocio || cli.empresa || cli.nombre || '', cli.nombreResponsable || cli.responsable || '',
          cli.telefono || '', cli.email || '', cli.direccion || '', cli.departamento || '', cli.distrito || cli.ciudad || '',
          fechaHoy, cli.ultimaCompra || '', cli.totalPedidos || 0, cli.totalComprado || 0, cli.totalKg || 0, cli.estado || 'ACTIVO',
          cli.tipoEnvio || '', cli.empresaEnvio || '', cli.localEnvio || '', cli.direccionEnvio || '', cli.distritoEnvio || '', cli.departamentoEnvio || '', cli.notas || ''
        ]);

        resultados.creados.push(whatsappLimpio);
        existingWhatsapps.add(whatsappLimpio);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (e) { resultados.errores.push({ whatsapp: cli.whatsapp, error: e.message }); }
    }

    res.json({ success: true, resumen: { total: clientes.length, creados: resultados.creados.length, existentes: resultados.existentes.length, errores: resultados.errores.length }, detalles: resultados });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:businessId/:clienteId/mensaje', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ error: 'Campo requerido: mensaje' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

router.post('/:businessId/:clienteId/actualizar-stats', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Clientes!A:V');
    let clienteRow = -1, whatsapp = '';

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) { clienteRow = i + 1; whatsapp = rows[i][1]; break; }
    }

    if (clienteRow === -1) return res.status(404).json({ error: 'Cliente no encontrado' });

    let pedidos = [];
    try { pedidos = await sheets.getPedidosByWhatsapp(whatsapp); } catch (e) {}

    const totalPedidos = pedidos.length;
    const totalComprado = pedidos.reduce((sum, p) => sum + (p.total || 0), 0);
    let totalKg = 0;
    for (const pedido of pedidos) {
      const productos = pedido.productos || '';
      const kgMatch = productos.match(/(\d+(?:\.\d+)?)\s*kg/gi);
      if (kgMatch) for (const match of kgMatch) { const kg = parseFloat(match); if (!isNaN(kg)) totalKg += kg; }
    }
    const ultimaCompra = pedidos.length > 0 ? pedidos[0].fecha : '';

    await sheets.batchUpdate([
      { range: `Clientes!K${clienteRow}`, value: ultimaCompra },
      { range: `Clientes!L${clienteRow}`, value: totalPedidos },
      { range: `Clientes!M${clienteRow}`, value: totalComprado },
      { range: `Clientes!N${clienteRow}`, value: totalKg }
    ]);

    res.json({ success: true, stats: { totalPedidos, totalComprado, totalKg, ultimaCompra } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
