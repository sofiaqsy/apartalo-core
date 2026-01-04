/**
 * APARTALO CORE - API Routes
 * 
 * FIX: getRows() ahora solo recibe 'range' (sheets-service usa this.spreadsheetId internamente)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const WhatsAppService = require('../core/services/whatsapp-service');
const SheetsService = require('../core/services/sheets-service');

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
      const sheets = new SheetsService(negocio.spreadsheetId);
      await sheets.initialize();
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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
    const { estado } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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
    const { whatsapp, cliente, telefono, direccion, productos, total, observaciones, estado, origen, notificarCliente, departamento, ciudad, tipoEnvio, metodoEnvio, detalleEnvio, costoEnvio } = req.body;

    if (!whatsapp || !productos || total === undefined) {
      return res.status(400).json({ error: 'Campos requeridos: whatsapp, productos, total' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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
      '', observaciones || '', departamento || '', ciudad || '', tipoEnvio || '',
      metodoEnvio || '', detalleEnvio || '', costoEnvioNumero, origenFinal
    ];

    await sheets.appendRow('Pedidos', valores);

    if (notificarCliente && whatsapp !== '000000000') {
      try {
        const whatsappService = new WhatsAppService(negocio.whatsapp);
        const mensaje = `✅ *Pedido Registrado*\n\n📦 Pedido: *${pedidoId}*\n💰 Total: *S/ ${totalNumero.toFixed(2)}*\n📝 Productos: ${productosStr}\n\n¡Gracias por tu compra!`;
        await whatsappService.sendMessage(whatsapp, mensaje);
      } catch (e) { console.log('⚠️ Error notificando:', e.message); }
    }

    console.log(`✅ Pedido creado: ${pedidoId} - ${estadoFinal} - ${origenFinal}`);
    res.status(201).json({ success: true, mensaje: 'Pedido creado', pedido: { id: pedidoId, fecha: fechaPeru, hora: horaPeru, whatsapp, cliente, productos: productosStr, total: totalNumero, estado: estadoFinal, origen: origenFinal } });
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/pedidos/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { estado, observaciones, notificarCliente } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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

// CLIENTES
router.get('/clientes/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, departamento, ordenar } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    const rows = await sheets.getRows('Clientes!A:K');

    let clientes = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;
      const cliente = {
        id: row[0] || '', whatsapp: row[1] || '', nombre: row[2] || '', telefono: row[3] || '',
        direccion: row[4] || '', fechaRegistro: row[5] || '', ultimaCompra: row[6] || '',
        departamento: row[7] || '', ciudad: row[8] || '', empresa: row[9] || '', notas: row[10] || '', rowIndex: i + 1
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    const rows = await sheets.getRows('Clientes!A:K');
    let cliente = null;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === clienteId) {
        cliente = {
          id: rows[i][0], whatsapp: rows[i][1] || '', nombre: rows[i][2] || '', telefono: rows[i][3] || '',
          direccion: rows[i][4] || '', fechaRegistro: rows[i][5] || '', ultimaCompra: rows[i][6] || '',
          departamento: rows[i][7] || '', ciudad: rows[i][8] || '', empresa: rows[i][9] || '', notas: rows[i][10] || '', rowIndex: i + 1
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
    const { whatsapp, nombre, telefono, direccion, departamento, ciudad, empresa, notas } = req.body;
    if (!whatsapp || !nombre) return res.status(400).json({ error: 'Campos requeridos: whatsapp, nombre' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const clienteExistente = await sheets.buscarCliente(whatsapp);
    if (clienteExistente) return res.status(400).json({ error: 'Ya existe un cliente con ese WhatsApp', clienteExistente: clienteExistente.id });

    const clienteId = `CLI-${Date.now().toString().slice(-6)}`;
    const fechaHoy = formatPeruDate();

    await sheets.appendRow('Clientes', [clienteId, whatsapp.replace(/[^0-9]/g, ''), nombre, telefono || '', direccion || '', fechaHoy, '', departamento || '', ciudad || '', empresa || '', notas || '']);

    res.status(201).json({ success: true, mensaje: 'Cliente creado', cliente: { id: clienteId, whatsapp: whatsapp.replace(/[^0-9]/g, ''), nombre, telefono: telefono || '', direccion: direccion || '', fechaRegistro: fechaHoy, departamento: departamento || '', ciudad: ciudad || '', empresa: empresa || '', notas: notas || '' } });
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    const rows = await sheets.getRows('Clientes!A:K');

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

router.post('/clientes/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { clientes } = req.body;
    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) return res.status(400).json({ error: 'Se requiere array de clientes' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

// PRECIOS CLIENTE
router.get('/precios-cliente/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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
    if (!precios || typeof precios !== 'object') return res.status(400).json({ error: 'Campo requerido: precios' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

    const negocios = negociosService.getAll();
    for (const negocio of negocios) {
      let whatsappAdmin = (negocio.whatsapp?.admin || '').toString().replace(/[^0-9]/g, '');
      if (whatsappAdmin.length === 9) whatsappAdmin = '51' + whatsappAdmin;
      if (whatsappAdmin && whatsappAdmin === whatsapp) {
        return res.json({ encontrado: true, negocio: { id: negocio.id, nombre: negocio.nombre, flujo: negocio.flujo, features: negocio.features, whatsappAdmin } });
      }
    }
    res.json({ encontrado: false, mensaje: 'No se encontró ningún negocio asociado a este número' });
  } catch (error) {
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

// PRODUCTOS
router.get('/productos/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, buscar, ordenar, pagina = 1, limite = 20 } = req.query;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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
    const { codigo, nombre, descripcion, precio, stock, imagenUrl, estado, categoria } = req.body;
    if (!codigo || !nombre || precio === undefined || stock === undefined) return res.status(400).json({ error: 'Campos requeridos: codigo, nombre, precio, stock' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const productos = await sheets.getProductos();
    if (productos.find(p => p.codigo === codigo)) return res.status(400).json({ error: 'Ya existe un producto con ese código' });

    const precioNumero = parseDecimal(precio);
    const stockNumero = parseInt(stock) || 0;

    await sheets.appendRow('Inventario', [codigo, nombre, descripcion || '', precioNumero, stockNumero, 0, imagenUrl || '', estado || 'ACTIVO', categoria || '']);

    res.status(201).json({ success: true, mensaje: 'Producto creado', producto: { codigo, nombre, descripcion: descripcion || '', precio: precioNumero, stock: stockNumero, stockReservado: 0, imagenUrl: imagenUrl || '', estado: estado || 'ACTIVO', categoria: categoria || '', disponible: stockNumero } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/productos/:businessId/:codigo', async (req, res) => {
  try {
    const { businessId, codigo } = req.params;
    const { nombre, descripcion, precio, stock, imagenUrl, estado, categoria } = req.body;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    const rows = await sheets.getRows('Inventario!A:I');

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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
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

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

module.exports = router;
