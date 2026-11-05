/**
 * CLIENTES ROUTER
 * Migrado a Supabase — Google Sheets eliminado.
 */

const express = require('express');
const router  = express.Router();
const negociosService  = require('../config/negocios');
const WhatsAppService  = require('../core/services/whatsapp-service');
const supabaseService  = require('../core/services/supabase-service');

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ── Helper: map Supabase profile + address → cliente DTO ─────────────────────

function mapGuestCliente(order) {
  const addr = order.shipping_address || {};
  return {
    id:                 `guest:${order.customer_phone || order.customer_email}`,
    whatsapp:           order.customer_phone || '',
    nombreNegocio:      '',
    nombreResponsable:  order.customer_name  || '',
    telefono:           order.customer_phone || '',
    email:              String(order.customer_email || ''),
    fechaRegistro:      order.created_at ? new Date(order.created_at).toLocaleDateString('es-PE') : '',
    direccion:          addr.line1 || '',
    distrito:           addr.district || addr.city || '',
    departamento:       addr.department || '',
    direccionEnvio:     addr.line1 || '',
    distritoEnvio:      addr.district || addr.city || '',
    departamentoEnvio:  addr.department || '',
    tipoEnvio:          addr.delivery_method === 'pickup' ? 'SEDE' : (addr.line1 ? 'LOCAL' : ''),
    empresaEnvio: '', localEnvio: '',
    ultimaCompra: '', totalPedidos: 0, totalComprado: 0, totalKg: 0,
    totalPorCobrar: 0, pedidosActivos: 0, pedidosPorCobrar: 0, pedidosPagados: 0,
    estado: 'INVITADO', notas: 'Cliente sin cuenta'
  };
}

function mapCliente(p, addr) {
  const courier = Array.isArray(addr?.customer_address_courier)
    ? addr.customer_address_courier[0]
    : addr?.customer_address_courier;
  return {
    id:                 p.id,
    whatsapp:           p.phone        || '',
    nombreNegocio:      p.business_name || '',
    nombreResponsable:  p.full_name     || '',
    telefono:           p.phone        || '',
    email:              p.email        || '',
    fechaRegistro:      p.created_at ? new Date(p.created_at).toLocaleDateString('es-PE') : '',
    // address fields
    direccion:          addr?.address_line   || '',
    distrito:           addr?.district       || '',
    departamento:       addr?.department     || '',
    direccionEnvio:     addr?.address_line   || '',
    distritoEnvio:      addr?.district       || '',
    departamentoEnvio:  addr?.department     || '',
    tipoEnvio:          courier?.company ? 'NACIONAL' : (addr?.address_line ? 'LOCAL' : ''),
    empresaEnvio:       courier?.company     || '',
    localEnvio:         courier?.agency      || '',
    // defaults
    ultimaCompra: '', totalPedidos: 0, totalComprado: 0, totalKg: 0,
    totalPorCobrar: 0, pedidosActivos: 0, pedidosPorCobrar: 0, pedidosPagados: 0,
    estado: 'ACTIVO', notas: ''
  };
}

// ── GET /:businessId — lista de clientes ─────────────────────────────────────

router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { buscar, ordenar, limite = 50 } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const limiteNum = parseInt(limite) || 50;
    const profiles  = await supabaseService.getAllCustomers({ search: buscar, limit: limiteNum });

    // Batch fetch primary addresses
    const customerIds = profiles.map(p => p.id);
    let addrMap = {};
    try {
      const addresses = await supabaseService.getAddressesByCustomers(customerIds);
      for (const addr of addresses) {
        if (!addrMap[addr.customer_id]) addrMap[addr.customer_id] = addr;
      }
    } catch (e) {
      console.warn('[Clientes GET] No se pudieron cargar direcciones:', e.message);
    }

    let clientes = profiles.map(p => mapCliente(p, addrMap[p.id]));

    // Merge guest customers (orders placed without an account)
    try {
      // Normalize phone: strip leading 51 country code for comparison
      const normalizePhone = p => String(p || '').replace(/^51/, '');
      const seen = new Set(profiles.map(p => normalizePhone(p.phone)).filter(Boolean));
      profiles.forEach(p => p.email && seen.add(String(p.email)));

      const guestOrders = await supabaseService.getGuestCustomers(negocio.farmId, { search: buscar });
      if (guestOrders.length) {
        for (const o of guestOrders) {
          const phoneKey = normalizePhone(o.customer_phone);
          const emailKey = String(o.customer_email || '');
          if ((phoneKey && seen.has(phoneKey)) || (emailKey && seen.has(emailKey))) continue;
          if (phoneKey) seen.add(phoneKey);
          if (emailKey) seen.add(emailKey);
          clientes.push(mapGuestCliente(o));
        }
      }
    } catch (e) {
      console.warn('[Clientes GET] No se pudieron cargar invitados:', e.message);
    }

    if (ordenar === 'nombre') {
      clientes.sort((a, b) => (a.nombreResponsable || a.nombreNegocio).localeCompare(b.nombreResponsable || b.nombreNegocio));
    }

    res.json({ total: clientes.length, pagina: 1, totalPaginas: 1, hayMas: false, clientes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /:businessId/:clienteId — detalle ────────────────────────────────────

router.get('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (!isUUID(clienteId)) {
      return res.status(400).json({ error: 'ID de cliente inválido (se requiere UUID)' });
    }

    const profile = await supabaseService.getCustomerById(clienteId);
    if (!profile) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Primary address
    let addr = null;
    try {
      const addrs = await supabaseService.getAddressesByCustomer(clienteId);
      addr = addrs.find(a => a.is_primary) || addrs[0] || null;
    } catch (_) {}

    const cliente = mapCliente(profile, addr);

    // Orders from Supabase: this customer's (before 5 Nov 2026 only the farm's 50 newest orders were looked at, so older
    // orders of a customer were missed).
    let pedidos = [];
    try {
      const result = await supabaseService.getOrdersByFarm(negocio.farmId, { comprador: { id: profile.id, telefono: profile.phone }, limite: 50 });
      pedidos = result.pedidos || [];
      // Enrich stats
      let totalComprado = 0, totalPedidos = pedidos.length, ultimaCompra = '';
      for (const p of pedidos) {
        if ((p.estado || '').toUpperCase() === 'COMPLETADO') totalComprado += (p.total || 0);
        if (!ultimaCompra || p.fecha > ultimaCompra) ultimaCompra = p.fecha;
      }
      cliente.totalPedidos  = totalPedidos;
      cliente.totalComprado = totalComprado;
      cliente.ultimaCompra  = ultimaCompra;
    } catch (_) {}

    res.json({ cliente, pedidos, estadisticas: { totalPedidos: cliente.totalPedidos, totalComprado: cliente.totalComprado } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /:businessId/:clienteId/pedidos — the customer's orders, 20 at a time ────────────────────────────────
// Client detail → Pedidos, in place of Estadísticas (General Manager, 5 Nov 2026). The newest first, in the Pedidos tab's
// shape, so each one opens the same order detail.

async function comprador(req, res) {
  const { businessId, clienteId } = req.params;
  const negocio = negociosService.getById(businessId);
  if (!negocio) { res.status(404).json({ error: 'Negocio no encontrado' }); return null; }
  if (!isUUID(clienteId)) { res.status(400).json({ error: 'ID de cliente inválido (se requiere UUID)' }); return null; }
  const profile = await supabaseService.getCustomerById(clienteId);
  if (!profile) { res.status(404).json({ error: 'Cliente no encontrado' }); return null; }
  return { negocio, profile };
}

router.get('/:businessId/:clienteId/pedidos', async (req, res) => {
  try {
    const c = await comprador(req, res);
    if (!c) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const r = await supabaseService.getOrdersByFarm(c.negocio.farmId, {
      comprador: { id: c.profile.id, telefono: c.profile.phone }, limite: 100000,
    });
    const todos = r.pedidos || [];
    res.json({ pedidos: todos.slice(offset, offset + limit), total: todos.length, hayMas: todos.length > offset + limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /:businessId/:clienteId/reporte?desde=2026-05&hasta=2026-10 — the customer's report ─────────────────────
// The same form as Administración's reports (Mensual or Anual, at most 12 months; General Manager, 5 Nov 2026): every
// order registered in the period, cancelled ones too, with its status, whether it is paid, partly paid or not, the day
// it was registered and the day it was completed, and each payment with its day, amount and BCP operation number.

const diaLima = iso => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) : null);

function lineaReporte(p) {
  const cancelado = p.estado === 'CANCELADO';
  const total = Number(p.total) || 0;
  const pagos = (p.pagos || []).map(pg => {
    const ops = [...new Set((p.evidencias || [])
      .filter(e => e.paymentId === pg.id && e.verificacion && e.verificacion.operacionBCP)
      .map(e => String(e.verificacion.operacionBCP)))];
    return { fecha: diaLima(pg.fecha), monto: Number(pg.monto) || 0, operacion: ops.length ? ops.join(', ') : null };
  });
  const pagado = Math.round(pagos.reduce((s, x) => s + x.monto, 0) * 100) / 100;
  return {
    pedido: p.id,
    registrado: diaLima(p.tracking && p.tracking.creadoEn),
    estado: p.estado,
    pago: pagado >= total && total > 0 ? 'Pagado' : (pagado > 0 ? 'Parcial' : 'Sin pagar'),
    total, pagado, debe: cancelado ? 0 : Math.max(Math.round((total - pagado) * 100) / 100, 0),
    completado: diaLima(p.fechaCompletado),
    pagos,
  };
}

router.get('/:businessId/:clienteId/reporte', async (req, res) => {
  try {
    const mesValido = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
    const { desde, hasta } = req.query;
    if (!mesValido(desde) || !mesValido(hasta)) return res.status(400).json({ error: 'Elige el mes Desde y el mes Hasta.' });
    const [da, dm] = desde.split('-').map(Number);
    const [ha, hm] = hasta.split('-').map(Number);
    const meses = (ha - da) * 12 + (hm - dm) + 1;
    if (meses < 1) return res.status(400).json({ error: 'El mes Hasta va después de Desde.' });
    if (meses > 12) return res.status(400).json({ error: 'Un reporte cubre como máximo 12 meses.' });
    const c = await comprador(req, res);
    if (!c) return;
    const inicio = `${desde}-01`;
    const fin = new Date(Date.UTC(ha, hm, 0)).toISOString().slice(0, 10); // last day of the Hasta month
    const r = await supabaseService.getOrdersByFarm(c.negocio.farmId, {
      comprador: { id: c.profile.id, telefono: c.profile.phone }, limite: 100000, orden: 'antiguos',
    });
    const pedidos = (r.pedidos || []).map(lineaReporte).filter(p => p.registrado && p.registrado >= inicio && p.registrado <= fin);
    const vigentes = pedidos.filter(p => p.estado !== 'CANCELADO');
    const suma = (xs, k) => Math.round(xs.reduce((s, x) => s + x[k], 0) * 100) / 100;
    res.json({ reporte: {
      cliente: c.profile.business_name || c.profile.full_name || c.profile.phone || 'Cliente',
      desde: inicio, hasta: fin, meses, anual: dm === 1 && hm === 12 && da === ha, generado: new Date().toISOString(),
      franja: {
        pedidos: pedidos.length, cancelados: pedidos.length - vigentes.length,
        total: suma(vigentes, 'total'), pagado: suma(vigentes, 'pagado'), debe: suma(vigentes, 'debe'),
      },
      pedidos,
    } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /:businessId — crear cliente ────────────────────────────────────────

router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { whatsapp, nombreNegocio, nombreResponsable, telefono, email, estado } = req.body;

    if (!whatsapp) return res.status(400).json({ error: 'Campo requerido: whatsapp' });
    if (!nombreNegocio && !nombreResponsable) return res.status(400).json({ error: 'Se requiere nombreNegocio o nombreResponsable' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const whatsappLimpio = whatsapp.replace(/[^0-9+]/g, '');

    const nuevo = await supabaseService.createCustomer({
      fullName:     nombreResponsable || '',
      businessName: nombreNegocio     || '',
      phone:        whatsappLimpio,
      email:        email || null
    });
    if (!nuevo) return res.status(500).json({ error: 'Error creando cliente' });

    res.status(201).json({
      success: true, mensaje: 'Cliente creado',
      cliente: { id: nuevo.id, whatsapp: whatsappLimpio, nombreNegocio: nombreNegocio || '', nombreResponsable: nombreResponsable || '', fechaRegistro: new Date().toLocaleDateString('es-PE'), estado: estado || 'ACTIVO' }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /:businessId/:clienteId — actualizar cliente ─────────────────────────

router.put('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { whatsapp, nombreNegocio, nombreResponsable } = req.body;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (!isUUID(clienteId)) return res.status(400).json({ error: 'ID de cliente inválido (se requiere UUID)' });

    const updates = {};
    if (nombreNegocio     !== undefined) updates.business_name = nombreNegocio;
    if (nombreResponsable !== undefined) updates.full_name      = nombreResponsable;
    if (whatsapp          !== undefined) updates.phone          = whatsapp.replace(/[^0-9+]/g, '');

    if (Object.keys(updates).length > 0) {
      await supabaseService.updateCustomer(clienteId, updates);
    }

    res.json({ success: true, mensaje: 'Cliente actualizado', clienteId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /:businessId/:clienteId — eliminar cliente ────────────────────────

router.delete('/:businessId/:clienteId', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (!isUUID(clienteId)) return res.status(400).json({ error: 'ID de cliente inválido (se requiere UUID)' });

    await supabaseService.updateCustomer(clienteId, { role: 'DELETED' });
    res.json({ success: true, mensaje: 'Cliente eliminado', clienteId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /:businessId/importar — importar clientes en bloque ─────────────────

router.post('/:businessId/importar', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { clientes } = req.body;
    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de clientes' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const resultados = { creados: [], existentes: [], errores: [] };

    for (const cli of clientes) {
      try {
        if (!cli.whatsapp) { resultados.errores.push({ whatsapp: cli.whatsapp, error: 'Falta whatsapp' }); continue; }
        const whatsappLimpio = cli.whatsapp.replace(/[^0-9]/g, '');

        // Check duplicate
        const existing = await supabaseService.getCustomerByPhone(whatsappLimpio).catch(() => null);
        if (existing) { resultados.existentes.push(whatsappLimpio); continue; }

        await supabaseService.createCustomer({
          fullName:     cli.nombreResponsable || cli.responsable || '',
          businessName: cli.nombreNegocio     || cli.empresa     || cli.nombre || '',
          phone:        whatsappLimpio,
          email:        cli.email || null
        });
        resultados.creados.push(whatsappLimpio);
      } catch (e) {
        resultados.errores.push({ whatsapp: cli.whatsapp, error: e.message });
      }
    }

    res.json({
      success: true,
      resumen: { total: clientes.length, creados: resultados.creados.length, existentes: resultados.existentes.length, errores: resultados.errores.length },
      detalles: resultados
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /:businessId/:clienteId/mensaje — enviar WhatsApp ───────────────────

router.post('/:businessId/:clienteId/mensaje', async (req, res) => {
  try {
    const { businessId, clienteId } = req.params;
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ error: 'Campo requerido: mensaje' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    if (!isUUID(clienteId)) return res.status(400).json({ error: 'ID de cliente inválido (se requiere UUID)' });

    const profile = await supabaseService.getCustomerById(clienteId);
    if (!profile?.phone) return res.status(404).json({ error: 'Cliente no encontrado o sin teléfono' });

    const whatsapp = new WhatsAppService(negocio.whatsapp);
    const result   = await whatsapp.sendMessage(profile.phone, mensaje);
    res.json({ success: true, messageId: result.messages?.[0]?.id, to: profile.phone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── DIRECCIONES (Supabase only) ───────────────────────────────────────────────

router.get('/:businessId/:clienteId/addresses', async (req, res) => {
  try {
    const { clienteId } = req.params;
    const addresses = await supabaseService.getAddressesByCustomer(clienteId);
    res.json({ total: addresses.length, addresses });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:businessId/:clienteId/addresses', async (req, res) => {
  try {
    const { clienteId } = req.params;
    const { alias, isPrimary, addressLine, district, department, reference, notes, courier } = req.body;
    const address = await supabaseService.createAddress(clienteId, { alias, isPrimary, addressLine, district, department, reference, notes, courier });
    res.status(201).json({ success: true, address });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:businessId/:clienteId/addresses/:addressId', async (req, res) => {
  try {
    const { addressId } = req.params;
    const { alias, isPrimary, addressLine, district, department, reference, notes, courier } = req.body;
    await supabaseService.updateAddress(addressId, { alias, isPrimary, addressLine, district, department, reference, notes, courier });
    res.json({ success: true, mensaje: 'Dirección actualizada', addressId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:businessId/:clienteId/addresses/:addressId', async (req, res) => {
  try {
    const { addressId } = req.params;
    await supabaseService.deleteAddress(addressId);
    res.json({ success: true, mensaje: 'Dirección eliminada', addressId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
