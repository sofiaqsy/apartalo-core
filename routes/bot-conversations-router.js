/**
 * APARTALO CORE - Bot Conversations Router
 * 
 * Endpoints para gestión de conversaciones del bot WhatsApp
 * Integración con app móvil Flutter
 * 
 * Estados de conversación:
 * - LISTENING: Bot activo, cliente interactúa con bot
 * - ACTIVA: Cliente solicitó asesor, esperando respuesta humana
 * - CERRADA: Conversación finalizada
 */

const express = require('express');
const router = express.Router();
const negociosService = require('../config/negocios');
const WhatsAppService = require('../core/services/whatsapp-service');
const SheetsService = require('../core/services/sheets-service');

// ============================================
// HELPERS
// ============================================

function cleanPhone(phone) {
  return (phone || '').replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
}

function getPeruDateTime() {
  const now = new Date();
  const peruTime = new Date(now.getTime() - (5 * 60 * 60 * 1000));
  return peruTime.toISOString();
}

async function getDatosUltimosMensajes(sheets, conversacionId, estado) {
  try {
    const rows = await sheets.getRows('Mensajes!A:F');
    let ultimoMensaje = '';
    let ultimoTipo = '';
    let mensajesSinResponder = 0;
    let ultimoFueCliente = false;

    const mensajesConv = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[1] === conversacionId && row[3] !== 'SISTEMA') {
        mensajesConv.push({
          tipo: row[3] || 'CLIENTE',
          mensaje: row[4] || '',
          timestamp: row[2] || ''
        });
      }
    }

    if (mensajesConv.length > 0) {
      const ultimo = mensajesConv[mensajesConv.length - 1];
      ultimoMensaje = ultimo.mensaje.length > 50 ? ultimo.mensaje.substring(0, 50) + '...' : ultimo.mensaje;
      ultimoTipo = ultimo.tipo;
      ultimoFueCliente = ultimoTipo === 'CLIENTE' || ultimoTipo === 'BOT';

      for (let i = mensajesConv.length - 1; i >= 0; i--) {
        if (mensajesConv[i].tipo === 'ASESOR') break;
        if (mensajesConv[i].tipo === 'CLIENTE' || mensajesConv[i].tipo === 'BOT') {
          mensajesSinResponder++;
        }
      }
    }

    const esPendiente = (estado === 'ACTIVA') && ultimoFueCliente && (mensajesSinResponder > 0);

    return {
      ultimoMensaje,
      ultimoTipo,
      pendienteRespuesta: esPendiente,
      mensajesSinResponder: esPendiente ? mensajesSinResponder : 0
    };
  } catch (error) {
    return { ultimoMensaje: '', ultimoTipo: '', pendienteRespuesta: false, mensajesSinResponder: 0 };
  }
}

// ============================================
// GET /bot/conversaciones/:businessId
// Obtener todas las conversaciones con estadísticas
// ============================================

router.get('/conversaciones/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { estado, soloActivas } = req.query;
    
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    
    const rows = await sheets.getRows('Conversaciones_Asesor!A:H');
    if (rows.length <= 1) return res.json({ total: 0, pendientes: 0, conversaciones: [] });

    const conversaciones = [];
    let totalPendientes = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const convId = row[0] || '';
      const estadoConv = row[4] || 'ACTIVA';

      // Filtrar por estado si se especifica
      if (estado && estadoConv !== estado) continue;
      
      // Filtrar solo activas/listening si se especifica
      if (soloActivas === 'true' && estadoConv === 'CERRADA') continue;

      const datosMsg = await getDatosUltimosMensajes(sheets, convId, estadoConv);
      
      if (datosMsg.pendienteRespuesta) totalPendientes++;

      conversaciones.push({
        id: convId,
        fechaInicio: row[1] || '',
        cliente: row[2] || 'Cliente',
        whatsapp: row[3] || '',
        estado: estadoConv,
        ultimaAct: row[5] || row[1] || '',
        vecesAtendida: parseInt(row[6]) || 0,
        ultimaCierre: row[7] || '',
        ultimoMensaje: datosMsg.ultimoMensaje,
        pendienteRespuesta: datosMsg.pendienteRespuesta,
        mensajesSinResponder: datosMsg.mensajesSinResponder,
        ultimoTipo: datosMsg.ultimoTipo,
        // Indicador visual para la app
        solicitaAsesor: estadoConv === 'ACTIVA'
      });
    }

    // Ordenar: pendientes primero, luego por fecha
    conversaciones.sort((a, b) => {
      if (a.pendienteRespuesta && !b.pendienteRespuesta) return -1;
      if (!a.pendienteRespuesta && b.pendienteRespuesta) return 1;
      
      const activaA = (a.estado === 'ACTIVA' || a.estado === 'LISTENING');
      const activaB = (b.estado === 'ACTIVA' || b.estado === 'LISTENING');
      if (activaA && !activaB) return -1;
      if (!activaA && activaB) return 1;
      
      return new Date(b.ultimaAct) - new Date(a.ultimaAct);
    });

    res.json({ 
      total: conversaciones.length, 
      pendientes: totalPendientes,
      conversaciones 
    });
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /bot/conversaciones/:businessId/:conversacionId/mensajes
// Obtener mensajes de una conversación
// ============================================

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
      if (String(row[1]) === String(conversacionId)) {
        mensajes.push({
          id: row[0] || '',
          conversacionId: row[1] || '',
          timestamp: row[2] || '',
          tipo: row[3] || 'CLIENTE',
          mensaje: row[4] || '',
          de: row[5] || ''
        });
      }
    }

    // Ordenar por timestamp
    mensajes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({ 
      conversacionId, 
      total: mensajes.length, 
      mensajes 
    });
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /bot/conversaciones/:businessId/:conversacionId/enviar
// Enviar mensaje como asesor
// ============================================

router.post('/conversaciones/:businessId/:conversacionId/enviar', async (req, res) => {
  try {
    const { businessId, conversacionId } = req.params;
    const { mensaje, asesor } = req.body;

    if (!mensaje) return res.status(400).json({ error: 'Mensaje es requerido' });

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // Obtener datos de la conversación
    const rows = await sheets.getRows('Conversaciones_Asesor!A:H');
    let conversacion = null;
    let convRowIndex = 0;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === conversacionId) {
        conversacion = {
          id: rows[i][0],
          cliente: rows[i][2],
          whatsapp: rows[i][3],
          estado: rows[i][4]
        };
        convRowIndex = i + 1;
        break;
      }
    }

    if (!conversacion) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    // Enviar por WhatsApp
    const whatsapp = new WhatsAppService(negocio.whatsapp);
    await whatsapp.sendMessage(conversacion.whatsapp, mensaje);

    // Guardar mensaje en Sheets
    const msgId = `MSG-${Date.now()}`;
    await sheets.appendRow('Mensajes', [
      msgId,
      conversacionId,
      getPeruDateTime(),
      'ASESOR',
      mensaje,
      asesor || 'Asesor'
    ]);

    // Actualizar última actividad de la conversación
    await sheets.updateCell(`Conversaciones_Asesor!F${convRowIndex}`, getPeruDateTime());

    res.json({ 
      success: true, 
      messageId: msgId,
      to: conversacion.whatsapp 
    });
  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PUT /bot/conversaciones/:businessId/:conversacionId/estado
// Actualizar estado de conversación
// ============================================

router.put('/conversaciones/:businessId/:conversacionId/estado', async (req, res) => {
  try {
    const { businessId, conversacionId } = req.params;
    const { estado } = req.body;

    if (!estado) return res.status(400).json({ error: 'Estado es requerido' });
    if (!['LISTENING', 'ACTIVA', 'CERRADA'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido. Use: LISTENING, ACTIVA, CERRADA' });
    }

    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    const rows = await sheets.getRows('Conversaciones_Asesor!A:H');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === conversacionId) {
        const updates = [
          { range: `Conversaciones_Asesor!E${i + 1}`, value: estado },
          { range: `Conversaciones_Asesor!F${i + 1}`, value: getPeruDateTime() }
        ];

        // Si se cierra, actualizar fecha de cierre y contador
        if (estado === 'CERRADA') {
          const vecesAtendida = parseInt(rows[i][6] || '0') + 1;
          updates.push({ range: `Conversaciones_Asesor!G${i + 1}`, value: vecesAtendida });
          updates.push({ range: `Conversaciones_Asesor!H${i + 1}`, value: getPeruDateTime() });
        }

        await sheets.batchUpdate(updates);

        return res.json({ 
          success: true, 
          conversacionId, 
          nuevoEstado: estado 
        });
      }
    }

    res.status(404).json({ error: 'Conversación no encontrada' });
  } catch (error) {
    console.error('Error actualizando estado:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /bot/clientes/:businessId/pendientes
// Obtener clientes que solicitan asesor (para indicador en lista)
// ============================================

router.get('/clientes/:businessId/pendientes', async (req, res) => {
  try {
    const { businessId } = req.params;
    
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    
    const rows = await sheets.getRows('Conversaciones_Asesor!A:H');
    const clientesPendientes = new Map(); // whatsapp -> datos

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const estado = row[4] || '';
      const whatsapp = cleanPhone(row[3] || '');

      // Solo ACTIVA = solicitó asesor
      if (estado === 'ACTIVA' && whatsapp) {
        const datosMsg = await getDatosUltimosMensajes(sheets, row[0], estado);
        
        // Si ya existe, mantener el más reciente
        if (!clientesPendientes.has(whatsapp) || 
            new Date(row[5]) > new Date(clientesPendientes.get(whatsapp).ultimaAct)) {
          clientesPendientes.set(whatsapp, {
            whatsapp,
            cliente: row[2] || 'Cliente',
            conversacionId: row[0],
            ultimaAct: row[5] || '',
            pendienteRespuesta: datosMsg.pendienteRespuesta,
            mensajesSinResponder: datosMsg.mensajesSinResponder,
            ultimoMensaje: datosMsg.ultimoMensaje
          });
        }
      }
    }

    const pendientes = Array.from(clientesPendientes.values());
    pendientes.sort((a, b) => new Date(b.ultimaAct) - new Date(a.ultimaAct));

    res.json({ 
      total: pendientes.length, 
      pendientes 
    });
  } catch (error) {
    console.error('Error obteniendo clientes pendientes:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GET /bot/cliente/:businessId/:whatsapp/conversacion
// Obtener conversación activa de un cliente por WhatsApp
// ============================================

router.get('/cliente/:businessId/:whatsapp/conversacion', async (req, res) => {
  try {
    const { businessId, whatsapp } = req.params;
    const waLimpio = cleanPhone(whatsapp);
    
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();
    
    const rows = await sheets.getRows('Conversaciones_Asesor!A:H');
    
    let conversacionActiva = null;
    let conversacionReciente = null;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const waRow = cleanPhone(row[3] || '');

      if (waRow === waLimpio) {
        const conv = {
          id: row[0],
          fechaInicio: row[1],
          cliente: row[2],
          whatsapp: row[3],
          estado: row[4] || 'ACTIVA',
          ultimaAct: row[5],
          vecesAtendida: parseInt(row[6]) || 0,
          ultimaCierre: row[7] || '',
          solicitaAsesor: row[4] === 'ACTIVA'
        };

        if (conv.estado !== 'CERRADA') {
          if (!conversacionActiva || new Date(conv.ultimaAct) > new Date(conversacionActiva.ultimaAct)) {
            conversacionActiva = conv;
          }
        } else {
          if (!conversacionReciente || new Date(conv.ultimaAct) > new Date(conversacionReciente.ultimaAct)) {
            conversacionReciente = conv;
          }
        }
      }
    }

    const conversacion = conversacionActiva || conversacionReciente;

    if (conversacion) {
      // Obtener mensajes
      const msgRows = await sheets.getRows('Mensajes!A:F');
      const mensajes = [];

      for (let i = 1; i < msgRows.length; i++) {
        if (msgRows[i][1] === conversacion.id) {
          mensajes.push({
            id: msgRows[i][0],
            timestamp: msgRows[i][2],
            tipo: msgRows[i][3],
            mensaje: msgRows[i][4]
          });
        }
      }

      mensajes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      res.json({ 
        existe: true, 
        conversacion,
        mensajes,
        totalMensajes: mensajes.length
      });
    } else {
      res.json({ existe: false, conversacion: null, mensajes: [] });
    }
  } catch (error) {
    console.error('Error obteniendo conversación de cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /bot/cliente/:businessId/:whatsapp/iniciar
// Iniciar nueva conversación con cliente
// ============================================

router.post('/cliente/:businessId/:whatsapp/iniciar', async (req, res) => {
  try {
    const { businessId, whatsapp } = req.params;
    const { cliente, mensaje } = req.body;
    const waLimpio = cleanPhone(whatsapp);
    
    const negocio = negociosService.getById(businessId);
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

    const sheets = new SheetsService(negocio.spreadsheetId);
    await sheets.initialize();

    // Verificar si ya existe conversación activa
    const rows = await sheets.getRows('Conversaciones_Asesor!A:E');
    for (let i = 1; i < rows.length; i++) {
      const waRow = cleanPhone(rows[i][3] || '');
      const estado = rows[i][4] || '';
      if (waRow === waLimpio && estado !== 'CERRADA') {
        return res.json({ 
          success: true, 
          yaExistia: true, 
          conversacionId: rows[i][0] 
        });
      }
    }

    // Crear nueva conversación
    const convId = `CONV-${Date.now().toString().slice(-8)}`;
    const ahora = getPeruDateTime();

    await sheets.appendRow('Conversaciones_Asesor', [
      convId,
      ahora,
      cliente || 'Cliente',
      waLimpio,
      'ACTIVA',
      ahora,
      1,
      ''
    ]);

    // Agregar mensaje de sistema
    const msgId = `MSG-${Date.now()}`;
    await sheets.appendRow('Mensajes', [
      msgId,
      convId,
      ahora,
      'SISTEMA',
      'Conversación iniciada desde la aplicación',
      'Sistema'
    ]);

    // Si hay mensaje inicial, enviarlo
    if (mensaje) {
      const whatsappService = new WhatsAppService(negocio.whatsapp);
      await whatsappService.sendMessage(waLimpio, mensaje);

      const msgId2 = `MSG-${Date.now() + 1}`;
      await sheets.appendRow('Mensajes', [
        msgId2,
        convId,
        getPeruDateTime(),
        'ASESOR',
        mensaje,
        'App'
      ]);
    }

    res.json({ 
      success: true, 
      yaExistia: false, 
      conversacionId: convId 
    });
  } catch (error) {
    console.error('Error iniciando conversación:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
