/**
 * TRACK ROUTER
 *
 * Public tracking page API for delivery confirmation.
 * URL structure: /track/:businessId/:pedidoId
 *
 * GET  /api/track/:businessId/:pedidoId          → pedido data (public)
 * POST /api/track/:businessId/:pedidoId/confirmar → validate admin phone + update estado
 */

const express = require('express');
const router = express.Router();
const negociosService   = require('../config/negocios');
const supabaseService   = require('../core/services/supabase-service');

// ── Helpers ───────────────────────────────────────────────

function stripPrecio(nombre) {
  return (nombre || '')
    .replace(/\s*[-–]\s*S\/\s*[\d.,]+\s*$/i, '')
    .replace(/\s*\(S\/\s*[\d.,]+\)\s*$/i, '')
    .trim();
}

function parseProductosPublico(productosStr) {
  if (!productosStr) return [];
  try {
    const parsed = JSON.parse(productosStr);
    if (Array.isArray(parsed)) {
      return parsed.map(p => ({
        cantidad: Number(p.cantidad || p.qty || 1),
        nombre: stripPrecio((p.nombre || p.name || '').toString().trim()),
      })).filter(p => p.nombre);
    }
  } catch (_) {}

  return productosStr.split(/\n|,/).map(line => {
    const m = line.trim().match(/^(\d+)x?\s+(.+)$/i);
    if (m) return { cantidad: parseInt(m[1]), nombre: stripPrecio(m[2]) };
    const t = line.trim();
    if (t) return { cantidad: 1, nombre: stripPrecio(t) };
    return null;
  }).filter(p => p && p.nombre);
}

function estadoToStep(estado) {
  const s = (estado || '').toUpperCase();
  if (s === 'RECIBIDO' || s === 'COMPLETADO') return 4;
  if (s === 'ENTREGADO') return 3;
  if (s === 'EN_CAMINO' || s === 'EN CAMINO') return 2;
  if (s === 'CONFIRMADO' || s === 'PREPARADO') return 1;
  return 0;
}

// ── GET /api/track/:businessId/:pedidoId ─────────────────

router.get('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    const productos    = parseProductosPublico(pedido.productos);
    const timelineStep = estadoToStep(pedido.estado);
    const tipoEnvio    = (pedido.tipoEnvio || '').toUpperCase();

    // Business address from local config (configExtra or top-level fields)
    const origen = {
      nombre:    negocio.nombre || businessId,
      direccion: negocio.configExtra?.direccion_tienda || negocio.direccion || '',
      ciudad:    negocio.configExtra?.departamento     || negocio.ciudad    || '',
    };

    const destino = {
      nombre:    '',
      direccion: pedido.direccion   || '',
      ciudad:    [pedido.ciudad, pedido.departamento].filter(Boolean).join(', '),
      referencia: pedido.referencia || '',
    };

    res.json({
      id:           pedido.id,
      fecha:        pedido.fecha,
      hora:         pedido.hora,
      estado:       pedido.estado || 'PENDIENTE',
      timelineStep,
      tipoEnvio,
      origen,
      destino,
      productos,
    });
  } catch (err) {
    console.error('[TRACK] Error GET:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /api/track/:businessId/:pedidoId/confirmar ──────

router.post('/:businessId/:pedidoId/confirmar', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;
    const { tipo, keyAprobacion } = req.body;

    if (!tipo || !keyAprobacion) {
      return res.status(400).json({ error: 'Se requiere tipo y keyAprobacion' });
    }
    if (!['entrega', 'recepcion'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo debe ser "entrega" o "recepcion"' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Validate keyAprobacion as an admin phone number in Supabase
    const adminData = await supabaseService.getAdminFarmsByPhone(keyAprobacion.toString().trim());
    const farmId = negocio.farmId;
    const esAdmin = adminData?.authorized &&
      adminData.farms.some(f => f.id === farmId);

    if (!esAdmin) {
      return res.status(401).json({ error: 'Codigo de aprobacion invalido' });
    }

    // Read current state
    const pedido = await supabaseService.getOrderByIdOrNumber(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    const nuevoEstado  = tipo === 'entrega' ? 'ENTREGADO' : 'RECIBIDO';
    const stepActual   = estadoToStep(pedido.estado);
    const stepNuevo    = estadoToStep(nuevoEstado);

    if (stepNuevo <= stepActual) {
      return res.status(400).json({ error: `El pedido ya está en estado ${pedido.estado}` });
    }

    await supabaseService.updateOrderStatus(pedidoId, nuevoEstado);

    console.log(`[TRACK] ${pedidoId} → ${nuevoEstado} (aprobado por admin del negocio ${businessId})`);

    res.json({
      ok:             true,
      pedidoId,
      estadoAnterior: pedido.estado,
      estadoNuevo:    nuevoEstado,
      timelineStep:   estadoToStep(nuevoEstado),
    });
  } catch (err) {
    console.error('[TRACK] Error POST confirmar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
