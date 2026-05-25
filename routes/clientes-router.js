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

    if (ordenar === 'nombre') {
      clientes.sort((a, b) => a.nombreNegocio.localeCompare(b.nombreNegocio));
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

    // Orders from Supabase
    let pedidos = [];
    try {
      const result = await supabaseService.getOrdersByFarm(negocio.farmId, {});
      pedidos = (result.pedidos || [])
        .filter(p => (p.whatsapp || '').replace(/\D/g, '') === (profile.phone || '').replace(/\D/g, ''))
        .slice(0, 50);
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
