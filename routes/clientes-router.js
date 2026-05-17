/**
 * CLIENTES ROUTER - Estructura completa
 * ACTUALIZACIÓN: Enriquecimiento con stats reales de pedidos, ordenar=actividad
 * FIX: getRows() solo recibe 'range' (sheets-service usa this.spreadsheetId internamente)
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const WhatsAppService = require('../core/services/whatsapp-service');
const supabaseService = require('../core/services/supabase-service');

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ==================== HELPER: Determinar estado de pago ====================

function determinarEstadoPago(pedido) {
  const estadoPagoExplicito = (pedido.estadoPago || '').toUpperCase();
  if (estadoPagoExplicito === 'PAGADO' || estadoPagoExplicito === 'PARCIAL') {
    return estadoPagoExplicito;
  }

  const total = pedido.total || 0;
  const montoPagado = pedido.montoPagado || 0;

  if (montoPagado >= total && total > 0) return 'PAGADO';
  if (montoPagado > 0 && montoPagado < total) return 'PARCIAL';

  const evidencias = pedido.evidencias || [];
  if (Array.isArray(evidencias) && evidencias.length > 0) return 'PAGADO';

  return 'PENDIENTE_PAGO';
}

// ==================== HELPER: Parsear evidencias ====================

function parseEvidencias(raw) {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (e) {
    return raw.split(/[,\n]/).map(u => u.trim()).filter(u => u).map((url, i) => ({
      id: `ev_legacy_${i}`, url, tipo: 'WHATSAPP', fecha: new Date().toISOString()
    }));
  }
}

// ==================== HELPER: Build pedidos index by whatsapp ====================

function buildPedidosIndex(pedidosRows) {
  const index = {}; // whatsapp -> [pedido, pedido, ...]
  
  for (let i = 1; i < pedidosRows.length; i++) {
    const row = pedidosRows[i];
    if (!row[0] || row[0].includes('_DELETED')) continue;

    const whatsapp = (row[3] || '').replace(/[^0-9]/g, '');
    if (!whatsapp) continue;

    const pedido = {
      id: row[0] || '',
      fecha: row[1] || '',
      cliente: row[4] || '',
      productos: row[7] || '',
      total: parseFloat(row[8]) || 0,
      estado: (row[9] || 'PENDIENTE').toUpperCase(),
      evidencias: parseEvidencias(row[10]),
      estadoPago: row[15] || 'PENDIENTE_PAGO',
      montoPagado: parseFloat(row[16]) || 0,
      fechaPago: row[17] || ''
    };

    if (!index[whatsapp]) index[whatsapp] = [];
    index[whatsapp].push(pedido);
  }

  return index;
}

// ==================== HELPER: Calcular stats de un cliente ====================

function calcularStats(pedidos) {
  const stats = {
    totalPedidos: pedidos.length,
    totalComprado: 0,
    totalCobrado: 0,
    totalPorCobrar: 0,
    totalKg: 0,
    pedidosActivos: 0,
    pedidosPorCobrar: 0,
    pedidosPagados: 0,
    ultimaCompra: '',
    ultimoPedidoEstado: ''
  };

  if (pedidos.length === 0) return stats;

  // Ordenar por fecha desc para obtener última compra
  const pedidosOrdenados = [...pedidos].sort((a, b) => {
    // Formato fecha: dd/mm/yyyy
    const parseDate = (f) => {
      if (!f) return 0;
      const parts = f.split('/');
      if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
      return new Date(f).getTime() || 0;
    };
    return parseDate(b.fecha) - parseDate(a.fecha);
  });

  stats.ultimaCompra = pedidosOrdenados[0].fecha;
  stats.ultimoPedidoEstado = pedidosOrdenados[0].estado;

  for (const p of pedidos) {
    const estadoUpper = p.estado;

    // Pedidos activos (no completados ni cancelados)
    if (estadoUpper !== 'COMPLETADO' && estadoUpper !== 'CANCELADO') {
      stats.pedidosActivos++;
    }

    // Solo sumar totales de pedidos completados (ventas reales)
    if (estadoUpper === 'COMPLETADO') {
      stats.totalComprado += p.total;

      const estadoPagoEfectivo = determinarEstadoPago(p);
      if (estadoPagoEfectivo === 'PAGADO') {
        stats.totalCobrado += p.total;
        stats.pedidosPagados++;
      } else if (estadoPagoEfectivo === 'PARCIAL') {
        stats.totalCobrado += p.montoPagado;
        stats.totalPorCobrar += (p.total - p.montoPagado);
        stats.pedidosPorCobrar++;
      } else {
        stats.totalPorCobrar += p.total;
        stats.pedidosPorCobrar++;
      }
    }

    // Calcular Kg desde productos
    const productos = p.productos || '';
    const kgMatch = productos.match(/(\d+(?:\.\d+)?)\s*kg/gi);
    if (kgMatch) {
      for (const match of kgMatch) {
        const kg = parseFloat(match);
        if (!isNaN(kg)) stats.totalKg += kg;
      }
    }
  }

  return stats;
}

// ==================== GET CLIENTES (LISTA) ====================

router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, departamento, estado, ordenar, pagina = 1, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    console.log(`[Clientes GET] businessId=${businessId} plataformaExterna=${negocio.plataformaExterna} farmId=${negocio.farmId}`);

    if (negocio.plataformaExterna && negocio.farmId) {
      console.log(`[Clientes GET] → Supabase getAllCustomers`);
      const profiles = await supabaseService.getAllCustomers({ search: buscar });
      console.log(`[Clientes GET] → ${profiles.length} perfiles obtenidos`);
      let clientes = profiles.map(p => ({
        id: p.id, whatsapp: p.phone || '', nombreNegocio: p.full_name || '', nombreResponsable: p.full_name || '',
        telefono: p.phone || '', email: p.email || '', direccion: '', departamento: '', distrito: '',
        fechaRegistro: p.created_at ? new Date(p.created_at).toLocaleDateString('es-PE') : '',
        ultimaCompra: '', totalPedidos: 0, totalComprado: 0, totalKg: 0, totalPorCobrar: 0,
        pedidosActivos: 0, pedidosPorCobrar: 0, pedidosPagados: 0,
        estado: 'ACTIVO', tipoEnvio: '', empresaEnvio: '', localEnvio: '',
        direccionEnvio: '', distritoEnvio: '', departamentoEnvio: '', notas: ''
      }));
      if (buscar) {
        const s = buscar.toLowerCase();
        clientes = clientes.filter(c =>
          c.nombreNegocio.toLowerCase().includes(s) ||
          c.whatsapp.includes(buscar) ||
          c.email.toLowerCase().includes(s)
        );
      }
      if (ordenar === 'nombre') clientes.sort((a, b) => a.nombreNegocio.localeCompare(b.nombreNegocio));
      const total = clientes.length;
      const paginaNum = parseInt(pagina) || 1;
      const limiteNum = parseInt(limite) || 50;
      const totalPaginas = Math.ceil(total / limiteNum);
      const inicio = (paginaNum - 1) * limiteNum;
      return res.json({ total, pagina: paginaNum, totalPaginas, hayMas: paginaNum < totalPaginas, clientes: clientes.slice(inicio, inicio + limiteNum) });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // Cargar clientes Y pedidos en paralelo
    const [clientesRows, pedidosRows] = await Promise.all([
      sheets.getRows('Clientes!A:V'),
      sheets.getRows('Pedidos!A:R')
    ]);

    // Indexar pedidos por whatsapp
    const pedidosIndex = buildPedidosIndex(pedidosRows);

    let clientes = [];
    for (let i = 1; i < clientesRows.length; i++) {
      const row = clientesRows[i];
      if (!row[0] || row[0].includes('_DELETED')) continue;

      const whatsapp = (row[1] || '').replace(/[^0-9]/g, '');
      const pedidosCliente = pedidosIndex[whatsapp] || [];
      const stats = calcularStats(pedidosCliente);

      const cliente = {
        id: row[0] || '', whatsapp: row[1] || '', nombreNegocio: row[2] || '', nombreResponsable: row[3] || '',
        telefono: row[4] || '', email: row[5] || '', direccion: row[6] || '', departamento: row[7] || '',
        distrito: row[8] || '', fechaRegistro: row[9] || '',
        // Stats calculados en tiempo real desde pedidos
        ultimaCompra: stats.ultimaCompra,
        totalPedidos: stats.totalPedidos,
        totalComprado: stats.totalComprado,
        totalKg: stats.totalKg,
        totalPorCobrar: stats.totalPorCobrar,
        pedidosActivos: stats.pedidosActivos,
        pedidosPorCobrar: stats.pedidosPorCobrar,
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

    // Ordenamiento
    if (ordenar === 'nombre') {
      clientes.sort((a, b) => (a.nombreNegocio || a.nombreResponsable).localeCompare(b.nombreNegocio || b.nombreResponsable));
    } else if (ordenar === 'reciente') {
      clientes.sort((a, b) => new Date(b.fechaRegistro) - new Date(a.fechaRegistro));
    } else if (ordenar === 'ultima_compra') {
      clientes.sort((a, b) => {
        const parseDate = (f) => {
          if (!f) return 0;
          const parts = f.split('/');
          if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
          return new Date(f).getTime() || 0;
        };
        return parseDate(b.ultimaCompra) - parseDate(a.ultimaCompra);
      });
    } else if (ordenar === 'total_comprado') {
      clientes.sort((a, b) => b.totalComprado - a.totalComprado);
    } else if (ordenar === 'actividad') {
      // Primero: pedidos activos (pendientes), luego por cobrar, luego última compra
      clientes.sort((a, b) => {
        // Prioridad 1: los que tienen pedidos activos van primero
        if (a.pedidosActivos > 0 && b.pedidosActivos === 0) return -1;
        if (b.pedidosActivos > 0 && a.pedidosActivos === 0) return 1;
        if (a.pedidosActivos > 0 && b.pedidosActivos > 0) return b.pedidosActivos - a.pedidosActivos;

        // Prioridad 2: los que tienen pagos pendientes
        if (a.pedidosPorCobrar > 0 && b.pedidosPorCobrar === 0) return -1;
        if (b.pedidosPorCobrar > 0 && a.pedidosPorCobrar === 0) return 1;

        // Prioridad 3: los que tienen pedidos vs los que no
        if (a.totalPedidos > 0 && b.totalPedidos === 0) return -1;
        if (b.totalPedidos > 0 && a.totalPedidos === 0) return 1;

        // Prioridad 4: última compra más reciente
        const parseDate = (f) => {
          if (!f) return 0;
          const parts = f.split('/');
          if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
          return new Date(f).getTime() || 0;
        };
        return parseDate(b.ultimaCompra) - parseDate(a.ultimaCompra);
      });
    } else {
      // Default: actividad (mismo que arriba)
      clientes.sort((a, b) => {
        if (a.pedidosActivos > 0 && b.pedidosActivos === 0) return -1;
        if (b.pedidosActivos > 0 && a.pedidosActivos === 0) return 1;
        if (a.pedidosPorCobrar > 0 && b.pedidosPorCobrar === 0) return -1;
        if (b.pedidosPorCobrar > 0 && a.pedidosPorCobrar === 0) return 1;
        if (a.totalPedidos > 0 && b.totalPedidos === 0) return -1;
        if (b.totalPedidos > 0 && a.totalPedidos === 0) return 1;
        const parseDate = (f) => {
          if (!f) return 0;
          const parts = f.split('/');
          if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
          return new Date(f).getTime() || 0;
        };
        return parseDate(b.ultimaCompra) - parseDate(a.ultimaCompra);
      });
    }

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

// ==================== GET CLIENTE DETALLE ====================

router.get('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna && negocio.farmId && isUUID(clienteId)) {
      const profile = await supabaseService.getCustomerById(clienteId);
      if (!profile) return res.status(404).json({ error: 'Cliente no encontrado' });
      const cliente = {
        id: profile.id, whatsapp: profile.phone || '', nombreNegocio: profile.full_name || '', nombreResponsable: profile.full_name || '',
        telefono: profile.phone || '', email: profile.email || '', direccion: '', departamento: '', distrito: '',
        fechaRegistro: '', ultimaCompra: '', totalPedidos: 0, totalComprado: 0, totalKg: 0,
        estado: 'ACTIVO', tipoEnvio: '', empresaEnvio: '', localEnvio: '',
        direccionEnvio: '', distritoEnvio: '', departamentoEnvio: '', notas: ''
      };
      return res.json({ cliente, pedidos: [], estadisticas: calcularStats([]) });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const [clientesRows, pedidosRows] = await Promise.all([
      sheets.getRows('Clientes!A:V'),
      sheets.getRows('Pedidos!A:R')
    ]);

    let cliente = null;
    for (let i = 1; i < clientesRows.length; i++) {
      if (clientesRows[i][0] === clienteId) {
        cliente = {
          id: clientesRows[i][0], whatsapp: clientesRows[i][1] || '', nombreNegocio: clientesRows[i][2] || '', nombreResponsable: clientesRows[i][3] || '',
          telefono: clientesRows[i][4] || '', email: clientesRows[i][5] || '', direccion: clientesRows[i][6] || '', departamento: clientesRows[i][7] || '',
          distrito: clientesRows[i][8] || '', fechaRegistro: clientesRows[i][9] || '', ultimaCompra: clientesRows[i][10] || '',
          totalPedidos: parseInt(clientesRows[i][11]) || 0, totalComprado: parseFloat(clientesRows[i][12]) || 0, totalKg: parseFloat(clientesRows[i][13]) || 0,
          estado: clientesRows[i][14] || 'ACTIVO', tipoEnvio: clientesRows[i][15] || '', empresaEnvio: clientesRows[i][16] || '', localEnvio: clientesRows[i][17] || '',
          direccionEnvio: clientesRows[i][18] || '', distritoEnvio: clientesRows[i][19] || '', departamentoEnvio: clientesRows[i][20] || '', notas: clientesRows[i][21] || '', rowIndex: i + 1
        };
        break;
      }
    }

    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Buscar pedidos del cliente por whatsapp
    const whatsappLimpio = (cliente.whatsapp || '').replace(/[^0-9]/g, '');
    const pedidosIndex = buildPedidosIndex(pedidosRows);
    const pedidosCliente = pedidosIndex[whatsappLimpio] || [];

    // Calcular stats reales
    const stats = calcularStats(pedidosCliente);

    // Ordenar pedidos por fecha desc
    pedidosCliente.sort((a, b) => {
      const parseDate = (f) => {
        if (!f) return 0;
        const parts = f.split('/');
        if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
        return new Date(f).getTime() || 0;
      };
      return parseDate(b.fecha) - parseDate(a.fecha);
    });

    res.json({
      cliente,
      pedidos: pedidosCliente.slice(0, 50),
      estadisticas: stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CREAR CLIENTE ====================

router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { whatsapp, nombreNegocio, nombreResponsable, telefono, email, direccion, departamento, distrito, estado, tipoEnvio, empresaEnvio, localEnvio, direccionEnvio, distritoEnvio, departamentoEnvio, notas } = req.body;

    if (!whatsapp) return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    if (!nombreNegocio && !nombreResponsable) return res.status(400).json({ error: 'Se requiere al menos nombreNegocio o nombreResponsable' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const whatsappLimpio = whatsapp.replace(/[^0-9+]/g, '');

    if (negocio.plataformaExterna && negocio.farmId) {
      const nuevo = await supabaseService.createCustomer({
        fullName: nombreNegocio || nombreResponsable || '',
        phone: whatsappLimpio,
        email: email || null
      });
      if (!nuevo) return res.status(500).json({ error: 'Error creando cliente en Supabase' });

      // Mirror UUID to sheet col A
      if (negocio.spreadsheetId) {
        try {
          const sheets = new SheetsService(negocio.spreadsheetId);
          await sheets.initialize();
          await sheets.appendRow('Clientes', [nuevo.id, whatsappLimpio, nombreNegocio || '', nombreResponsable || '', telefono || '', email || '', direccion || '', departamento || '', distrito || '', new Date().toLocaleDateString('es-PE'), '', 0, 0, 0, estado || 'ACTIVO', tipoEnvio || '', empresaEnvio || '', localEnvio || '', direccionEnvio || '', distritoEnvio || '', departamentoEnvio || '', notas || '']);
        } catch (sheetsErr) {
          console.warn('[Clientes POST] No se pudo guardar en sheet:', sheetsErr.message);
        }
      }

      return res.status(201).json({ success: true, mensaje: 'Cliente creado', cliente: { id: nuevo.id, whatsapp: whatsappLimpio, nombreNegocio: nombreNegocio || '', nombreResponsable: nombreResponsable || '', fechaRegistro: new Date().toLocaleDateString('es-PE'), estado: estado || 'ACTIVO' } });
    }

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

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

// ==================== ACTUALIZAR CLIENTE ====================

router.put('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { whatsapp, nombreNegocio, nombreResponsable, telefono, email, direccion, departamento, distrito, estado, tipoEnvio, empresaEnvio, localEnvio, direccionEnvio, distritoEnvio, departamentoEnvio, notas } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (negocio.plataformaExterna && negocio.farmId && isUUID(clienteId)) {
      // Update core fields in Supabase
      const supabaseUpdates = {};
      if (nombreNegocio !== undefined || nombreResponsable !== undefined)
        supabaseUpdates.full_name = nombreNegocio || nombreResponsable;
      if (whatsapp !== undefined)
        supabaseUpdates.phone = whatsapp.replace(/[^0-9+]/g, '');
      if (Object.keys(supabaseUpdates).length > 0)
        await supabaseService.updateCustomer(clienteId, supabaseUpdates);

      // Update extra fields in sheet
      if (negocio.spreadsheetId) {
        try {
          const sheets = new SheetsService(negocio.spreadsheetId);
          await sheets.initialize();
          const rows = await sheets.getRows('Clientes!A:V');
          for (let i = 1; i < rows.length; i++) {
            if ((rows[i][0] || '').trim() === clienteId) {
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
              break;
            }
          }
        } catch (sheetsErr) {
          console.warn('[Clientes PUT] No se pudo actualizar sheet:', sheetsErr.message);
        }
      }
      return res.json({ success: true, mensaje: 'Cliente actualizado', clienteId });
    }

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

// ==================== ELIMINAR CLIENTE ====================

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

// ==================== IMPORTAR CLIENTES ====================

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

// ==================== ENVIAR MENSAJE ====================

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

// ==================== ACTUALIZAR STATS (manual) ====================

router.post('/:businessId/:clienteId/actualizar-stats', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const [clientesRows, pedidosRows] = await Promise.all([
      sheets.getRows('Clientes!A:V'),
      sheets.getRows('Pedidos!A:R')
    ]);

    let clienteRow = -1, whatsapp = '';
    for (let i = 1; i < clientesRows.length; i++) {
      if (clientesRows[i][0] === clienteId) { clienteRow = i + 1; whatsapp = (clientesRows[i][1] || '').replace(/[^0-9]/g, ''); break; }
    }

    if (clienteRow === -1) return res.status(404).json({ error: 'Cliente no encontrado' });

    const pedidosIndex = buildPedidosIndex(pedidosRows);
    const pedidosCliente = pedidosIndex[whatsapp] || [];
    const stats = calcularStats(pedidosCliente);

    await sheets.batchUpdate([
      { range: `Clientes!K${clienteRow}`, value: stats.ultimaCompra },
      { range: `Clientes!L${clienteRow}`, value: stats.totalPedidos },
      { range: `Clientes!M${clienteRow}`, value: stats.totalComprado },
      { range: `Clientes!N${clienteRow}`, value: stats.totalKg }
    ]);

    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
