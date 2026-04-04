/**
 * APARTALO CORE - Delivery Router
 *
 * Gestiona la hoja "Delivery" del spreadsheet de cada negocio.
 *
 * Columnas de la hoja Delivery:
 *   A  deliveryId
 *   B  pedidoId
 *   C  tipoEnvio        (LOCAL | NACIONAL | SEDE)
 *   D  origenNombre
 *   E  origenDireccion
 *   F  origenCiudad
 *   G  destinoNombre
 *   H  destinoDireccion
 *   I  destinoCiudad
 *   J  empresaEnvio     (solo NACIONAL)
 *   K  repartidorId     (solo LOCAL)
 *   L  estadoDelivery   (INACTIVO | DISPONIBLE | ASIGNADO | EN_CAMINO | ENTREGADO | CANCELADO)
 *   M  fechaCreacion
 *   N  fechaDisponible
 *   O  fechaEntrega
 */

const express = require('express');
const router  = express.Router();
const negociosService = require('../config/negocios');
const SheetsService   = require('../core/services/sheets-service');

const SHEET = 'Delivery';
const ESTADOS_VALIDOS = ['INACTIVO', 'DISPONIBLE', 'ASIGNADO', 'EN_CAMINO', 'ENTREGADO', 'CANCELADO'];

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToDelivery(row) {
  return {
    deliveryId:       row[0]  || '',
    pedidoId:         row[1]  || '',
    tipoEnvio:        row[2]  || '',
    origenNombre:     row[3]  || '',
    origenDireccion:  row[4]  || '',
    origenCiudad:     row[5]  || '',
    destinoNombre:    row[6]  || '',
    destinoDireccion: row[7]  || '',
    destinoCiudad:    row[8]  || '',
    empresaEnvio:     row[9]  || '',
    repartidorId:     row[10] || '',
    estadoDelivery:   row[11] || 'INACTIVO',
    fechaCreacion:    row[12] || '',
    fechaDisponible:  row[13] || '',
    fechaEntrega:     row[14] || '',
  };
}

function getPeruDate() {
  const now     = new Date();
  const peru    = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const d       = String(peru.getUTCDate()).padStart(2, '0');
  const m       = String(peru.getUTCMonth() + 1).padStart(2, '0');
  const y       = peru.getUTCFullYear();
  let   h       = peru.getUTCHours();
  const min     = String(peru.getUTCMinutes()).padStart(2, '0');
  const ampm    = h >= 12 ? 'p.m.' : 'a.m.';
  h = h % 12 || 12;
  return `${d}/${m}/${y} ${h}:${min} ${ampm}`;
}

// ── GET /:businessId — Listar registros de delivery ─────────────────────────
router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, pedidoId } = req.query;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(`${SHEET}!A:O`);
    if (!rows || rows.length <= 1) return res.json({ deliveries: [] });

    let deliveries = rows.slice(1).map(rowToDelivery);

    if (estado)    deliveries = deliveries.filter(d => d.estadoDelivery === estado.toUpperCase());
    if (pedidoId)  deliveries = deliveries.filter(d => d.pedidoId === pedidoId);

    res.json({ deliveries });
  } catch (error) {
    console.error('❌ [Delivery] Error listando:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /:businessId/:deliveryId — Un registro ──────────────────────────────
router.get('/:businessId/:deliveryId', async (req, res) => {
  try {
    const { businessId, deliveryId } = req.params;

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(`${SHEET}!A:O`);
    if (!rows || rows.length <= 1) return res.status(404).json({ error: 'Delivery no encontrado' });

    const idx = rows.slice(1).findIndex(r => r[0] === deliveryId);
    if (idx === -1) return res.status(404).json({ error: 'Delivery no encontrado' });

    res.json({ delivery: rowToDelivery(rows[idx + 1]) });
  } catch (error) {
    console.error('❌ [Delivery] Error obteniendo:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /:businessId — Crear registro de delivery manualmente ───────────────
router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      pedidoId, tipoEnvio,
      origenNombre, origenDireccion, origenCiudad,
      destinoNombre, destinoDireccion, destinoCiudad,
      empresaEnvio, repartidorId,
    } = req.body;

    if (!pedidoId) return res.status(400).json({ error: 'Campo requerido: pedidoId' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const deliveryId = `DEL-${Date.now().toString().slice(-8)}`;

    const valores = [
      deliveryId,
      pedidoId,
      (tipoEnvio || '').toUpperCase(),
      origenNombre     || '',
      origenDireccion  || '',
      origenCiudad     || '',
      destinoNombre    || '',
      destinoDireccion || '',
      destinoCiudad    || '',
      empresaEnvio     || '',
      repartidorId     || '',
      'INACTIVO',
      getPeruDate(),
      '',
      '',
    ];

    await sheets.appendRow(SHEET, valores);

    res.status(201).json({
      success: true,
      delivery: rowToDelivery(valores),
    });
  } catch (error) {
    console.error('❌ [Delivery] Error creando:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── PATCH /:businessId/:deliveryId — Actualizar estado / repartidor ──────────
router.patch('/:businessId/:deliveryId', async (req, res) => {
  try {
    const { businessId, deliveryId } = req.params;
    const { estadoDelivery, repartidorId } = req.body;

    if (estadoDelivery && !ESTADOS_VALIDOS.includes(estadoDelivery.toUpperCase())) {
      return res.status(400).json({
        error: `Estado inválido. Válidos: ${ESTADOS_VALIDOS.join(', ')}`,
      });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows(`${SHEET}!A:O`);
    if (!rows || rows.length <= 1) return res.status(404).json({ error: 'Delivery no encontrado' });

    const idx = rows.slice(1).findIndex(r => r[0] === deliveryId);
    if (idx === -1) return res.status(404).json({ error: 'Delivery no encontrado' });

    const rowNum = idx + 2; // +1 header, +1 base-1

    // Actualizar estadoDelivery (col L = columna 12)
    if (estadoDelivery) {
      const nuevoEstado = estadoDelivery.toUpperCase();
      await sheets.updateCell(`${SHEET}!L${rowNum}`, nuevoEstado);

      // Marcar fechaDisponible cuando pasa a DISPONIBLE (col N = 14)
      if (nuevoEstado === 'DISPONIBLE' && !rows[idx + 1][13]) {
        await sheets.updateCell(`${SHEET}!N${rowNum}`, getPeruDate());
      }

      // Marcar fechaEntrega cuando se entrega (col O = 15)
      if (nuevoEstado === 'ENTREGADO') {
        await sheets.updateCell(`${SHEET}!O${rowNum}`, getPeruDate());
      }
    }

    // Actualizar repartidorId (col K = columna 11)
    if (repartidorId !== undefined) {
      await sheets.updateCell(`${SHEET}!K${rowNum}`, repartidorId);
    }

    res.json({ success: true, message: 'Delivery actualizado' });
  } catch (error) {
    console.error('❌ [Delivery] Error actualizando:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
