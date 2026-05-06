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
 * Strips price suffix from a product name.
 * Handles patterns like: "Cafe Molido - S/27.00" → "Cafe Molido"
 */
function stripPrecio(nombre) {
  return (nombre || '')
    .replace(/\s*[-–]\s*S\/\s*[\d.,]+\s*$/i, '')  // "- S/27.00" at end
    .replace(/\s*\(S\/\s*[\d.,]+\)\s*$/i, '')       // "(S/27.00)" at end
    .trim();
}

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
        nombre: stripPrecio((p.nombre || p.name || '').toString().trim()),
      })).filter(p => p.nombre);
    }
  } catch (_) {}

  // Plain text format: "2x Cafe Molido - S/54.00\n1x Cafe en Grano - S/27.00"
  return productosStr.split(/\n|,/).map(line => {
    const m = line.trim().match(/^(\d+)x?\s+(.+)$/i);
    if (m) return { cantidad: parseInt(m[1]), nombre: stripPrecio(m[2]) };
    const t = line.trim();
    if (t) return { cantidad: 1, nombre: stripPrecio(t) };
    return null;
  }).filter(p => p && p.nombre);
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

    const productos    = parseProductosPublico(pedido.productos);
    const timelineStep = estadoToStep(pedido.estado);
    const tipoEnvio    = (pedido.tipoEnvio || '').toUpperCase();

    // ── Leer dirección del negocio desde Configuracion!A:B ───────────────────
    let bizConfig = {};
    try {
      const cfgRows = await sheets.getRows('Configuracion!A:B');
      for (let i = 1; i < cfgRows.length; i++) {
        const k = (cfgRows[i][0] || '').trim();
        const v = (cfgRows[i][1] || '').toString().trim();
        if (k) bizConfig[k] = v;
      }
    } catch (_) {}

    // ── Leer registro de Delivery para este pedido ───────────────────────────
    let delivery = null;
    try {
      const dRows = await sheets.getRows('Delivery!A:O');
      if (dRows && dRows.length > 1) {
        const dRow = dRows.slice(1).find(r => r[1] === pedido.id);
        if (dRow) {
          delivery = {
            deliveryId:       dRow[0]  || '',
            tipoEnvio:        dRow[2]  || '',
            origenNombre:     dRow[3]  || '',
            origenDireccion:  dRow[4]  || '',
            origenCiudad:     dRow[5]  || '',
            destinoNombre:    dRow[6]  || '',
            destinoDireccion: dRow[7]  || '',
            destinoCiudad:    dRow[8]  || '',
            empresaEnvio:     dRow[9]  || '',
            repartidorId:     dRow[10] || '',
            estadoDelivery:   dRow[11] || 'INACTIVO',
            fechaCreacion:    dRow[12] || '',
            fechaDisponible:  dRow[13] || '',
            fechaEntrega:     dRow[14] || '',
          };
        }
      }
    } catch (_) {}

    // ── Origen: del registro Delivery o fallback al negocio ──────────────────
    const origen = {
      nombre:    delivery?.origenNombre    || negocio.nombre || businessId,
      direccion: delivery?.origenDireccion || bizConfig['direccion_tienda'] || negocio.direccion || '',
      ciudad:    delivery?.origenCiudad    || bizConfig['departamento']     || negocio.ciudad    || '',
    };

    // ── Destino: del registro Delivery o fallback al pedido ──────────────────
    const destino = {
      nombre:    delivery?.destinoNombre    || '',
      direccion: delivery?.destinoDireccion || pedido.direccion || '',
      ciudad:    delivery?.destinoCiudad    || [pedido.ciudad, pedido.departamento].filter(Boolean).join(', '),
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
      delivery,
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
