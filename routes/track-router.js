/**
 * TRACK ROUTER
 *
 * Public tracking page API for delivery confirmation.
 * URL structure: /track/:businessId/:pedidoId
 *
 * GET  /api/track/:businessId/:pedidoId          → pedido data (public)
 * POST /api/track/:businessId/:pedidoId/confirmar → validate key + update estado
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const SheetsService = require('../core/services/sheets-service');
const usuariosNegociosService = require('../core/services/usuarios-negocios-service');

// ── Helpers ───────────────────────────────────────────────

/**
 * Parse products string into [{qty, nombre}] — strips prices
 */
function parseProductosPublico(productosStr) {
  if (!productosStr) return [];
  try {
    const parsed = JSON.parse(productosStr);
    if (Array.isArray(parsed)) {
      return parsed.map(p => ({
        cantidad: Number(p.cantidad || p.qty || 1),
        nombre: (p.nombre || p.name || '').toString().trim(),
      })).filter(p => p.nombre);
    }
  } catch (_) {}

  // Plain text format: "2x Cafe Molido\n1x Cafe en Grano"
  return productosStr.split(/\n|,/).map(line => {
    const m = line.trim().match(/^(\d+)x?\s+(.+)$/i);
    if (m) return { cantidad: parseInt(m[1]), nombre: m[2].trim() };
    const t = line.trim();
    if (t) return { cantidad: 1, nombre: t };
    return null;
  }).filter(Boolean);
}

/**
 * Map pedido estado to timeline step index (0-based)
 * Steps: 0=Creado, 1=Preparado, 2=En camino, 3=Entregado, 4=Recibido
 */
function estadoToStep(estado) {
  const s = (estado || '').toUpperCase();
  if (s === 'RECIBIDO' || s === 'COMPLETADO') return 4;
  if (s === 'ENTREGADO') return 3;
  if (s === 'EN_CAMINO' || s === 'EN CAMINO') return 2;
  if (s === 'CONFIRMADO' || s === 'PREPARADO') return 1;
  return 0; // PENDIENTE or unknown
}

// ── GET /api/track/:businessId/:pedidoId ─────────────────

router.get('/:businessId/:pedidoId', async (req, res) => {
  try {
    const { businessId, pedidoId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const pedido = await sheets.getPedidoById(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    const productos = parseProductosPublico(pedido.productos);
    const timelineStep = estadoToStep(pedido.estado);

    const tipoEnvio = (pedido.tipoEnvio || '').toUpperCase();

    // Build origin (the business)
    const origen = {
      nombre:   negocio.nombre || negocio.name || businessId,
      direccion: negocio.direccion || negocio.address || '',
      ciudad:   negocio.ciudad || '',
    };

    // Build destination based on tipoEnvio
    // LOCAL  → client home address (pedido.direccion)
    // NACIONAL → courier office address (pedido.direccion already built from direccionEnvio)
    // SEDE   → pickup point only (pedido.direccion already built from sedeEnvio)
    const destino = {
      direccion: pedido.direccion || '',
      ciudad: [pedido.ciudad, pedido.departamento].filter(Boolean).join(', '),
    };

    // Build public response — no client name / phone / prices
    res.json({
      id: pedido.id,
      fecha: pedido.fecha,
      hora: pedido.hora,
      estado: pedido.estado || 'PENDIENTE',
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

    // Validate business
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    // Validate KeyAprobacion against UsuariosNegocios sheet
    const keyValida = await usuariosNegociosService.validarKeyAprobacion(
      keyAprobacion.toString().trim(),
      businessId
    );
    if (!keyValida) {
      return res.status(401).json({ error: 'Codigo de aprobacion invalido' });
    }

    // Update pedido estado
    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const pedido = await sheets.getPedidoById(pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    const nuevoEstado = tipo === 'entrega' ? 'ENTREGADO' : 'RECIBIDO';

    // Prevent going backwards in timeline
    const stepActual = estadoToStep(pedido.estado);
    const stepNuevo = estadoToStep(nuevoEstado);
    if (stepNuevo <= stepActual) {
      return res.status(400).json({ error: `El pedido ya está en estado ${pedido.estado}` });
    }

    await sheets.updateEstadoPedido(pedidoId, nuevoEstado);

    console.log(`[TRACK] ${pedidoId} → ${nuevoEstado} (aprobado por key válida de ${businessId})`);

    res.json({
      ok: true,
      pedidoId,
      estadoAnterior: pedido.estado,
      estadoNuevo: nuevoEstado,
      timelineStep: estadoToStep(nuevoEstado),
    });
  } catch (err) {
    console.error('[TRACK] Error POST confirmar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
