/**
 * APARTALO CORE - Webhook Router
 * 
 * Enruta mensajes de WhatsApp al handler correcto según:
 * - Negocios con número PROPIO: webhook específico
 * - Negocios con número COMPARTIDO: identifica por contexto
 * 
 * FEATURES:
 * - Guarda relación usuario-negocio en Sheets para persistencia
 * - Registra TODOS los mensajes (cliente y bot) para historial
 * - Soporta modo asesor (bloquea bot cuando asesor está activo)
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const negociosService = require('../config/negocios');
const stateManager = require('../core/services/state-manager');
const usuariosNegociosService = require('../core/services/usuarios-negocios-service');
const WhatsAppService = require('../core/services/whatsapp-service');
const SheetsService = require('../core/services/sheets-service');
const asesorService = require('../core/services/asesor-service');
const mensajeLogger = require('../core/services/mensaje-logger');

// Handlers
let estandarHandler = null;
const customHandlers = {};

// Prefijos para links directos
const PREFIJOS_NEGOCIOS = {
  'PLANTAS': 'plantas-vivero',
  'VIVERO': 'plantas-vivero',
  'ROSAL': 'tienda-rosal',
  'TIENDA': 'tienda-rosal',
  'CAFE': 'tienda-rosal'
};

// Negocio por defecto cuando no se identifica
const DEFAULT_BUSINESS_ID = 'BIZ-002';

/**
 * Inicializar handlers
 */
function initializeHandlers() {
  // Handler estándar (ApartaLo)
  try {
    estandarHandler = require('../handlers/estandar');
    console.log('✅ Handler estándar cargado');
  } catch (error) {
    console.log('⚠️ Handler estándar no disponible:', error.message);
  }

  // Cargar handlers custom
  const negocios = negociosService.getAll();
  
  for (const negocio of negocios) {
    if (negocio.flujo === 'CUSTOM') {
      try {
        customHandlers[negocio.id] = require(`../handlers/${negocio.id}`);
        console.log(`✅ Handler custom cargado: ${negocio.id}`);
      } catch (error) {
        console.log(`⚠️ Handler custom no encontrado para ${negocio.id}`);
      }
    }
  }

  // Inicializar servicio de usuarios-negocios
  usuariosNegociosService.initialize().catch(console.error);
}

// ============================================
// WEBHOOK VERIFICATION (GET)
// ============================================

router.get('/:businessId?', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsappShared.verifyToken) {
    console.log('✅ Webhook verificado');
    return res.status(200).send(challenge);
  }

  if (mode && token) {
    console.log('❌ Token de verificación incorrecto');
    return res.sendStatus(403);
  }

  res.json({
    status: 'active',
    endpoint: 'webhook',
    businessId: req.params.businessId || 'shared',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// WEBHOOK PARA NÚMERO PROPIO (POST /webhook/:businessId)
// ============================================

router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const negocio = negociosService.getById(businessId);
    
    if (!negocio) {
      console.log(`⚠️ Negocio no encontrado: ${businessId}`);
      return res.sendStatus(200);
    }

    // Para webhook específico, usar credenciales propias del negocio
    await processWebhook(body, negocio, false);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    res.sendStatus(200);
  }
});

// ============================================
// WEBHOOK COMPARTIDO (POST /webhook)
// ============================================

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const message = extractMessage(body);
    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || message.interactive?.button_reply?.id || '';
    
    console.log(`\n📨 Webhook compartido: ${from}`);
    console.log(`   Mensaje: "${text}"`);

    // 1. Verificar si es comando para cambiar de tienda
    if (text.toLowerCase() === 'cambiar tienda' || text.toLowerCase() === 'otra tienda') {
      await usuariosNegociosService.desvincularUsuario(from);
      stateManager.clearActiveBusiness(from);
      await mostrarSelectorNegocios(from);
      return res.sendStatus(200);
    }

    // 2. Intentar identificar negocio
    let negocio = await identificarNegocio(from, message);

    // 3. Procesar mensaje con el negocio identificado (usar credenciales compartidas)
    await processWebhook(body, negocio, true);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en webhook compartido:', error);
    res.sendStatus(200);
  }
});

// ============================================
// PROCESAMIENTO
// ============================================

async function processWebhook(body, negocio, useSharedCredentials = false) {
  if (!body.entry || body.entry.length === 0) return;

  for (const entry of body.entry) {
    if (!entry.changes || entry.changes.length === 0) continue;

    for (const change of entry.changes) {
      const value = change.value;

      if (value.messages && value.messages.length > 0) {
        for (const message of value.messages) {
          await processMessage(message, negocio, useSharedCredentials);
        }
      }

      if (value.statuses && value.statuses.length > 0) {
        for (const status of value.statuses) {
          console.log(`📊 Status: ${status.status} para ${status.id}`);
        }
      }
    }
  }
}

async function processMessage(message, negocio, useSharedCredentials = false) {
  const from = message.from;
  const messageId = message.id;

  console.log(`\n📱 Mensaje de ${from} para ${negocio.nombre}`);

  const context = await createContext(negocio, useSharedCredentials);
  
  const { text, mediaId, type, interactiveData } = extractMessageContent(message);

  console.log(`   Tipo: ${type}`);
  console.log(`   Texto: ${text}`);

  // ============================================
  // REGISTRAR MENSAJE DEL CLIENTE (TRACKING)
  // ============================================
  try {
    await mensajeLogger.logMensajeCliente(from, text || `[${type}]`, context.sheets);
  } catch (e) {
    console.log('⚠️ Error logging mensaje:', e.message);
  }

  // ============================================
  // VERIFICAR MODO ASESOR
  // ============================================
  const modoAsesorActivo = await asesorService.debeBloquerBot(from, context.sheets);
  
  if (modoAsesorActivo) {
    console.log('👤 MODO ASESOR ACTIVO - Bot NO responde');
    
    // Verificar si quiere salir del modo asesor
    const textLower = (text || '').toLowerCase().trim();
    if (textLower === 'menu' || textLower === 'menú' || textLower === 'salir') {
      await asesorService.desactivarModoAsesor(from, context.sheets);
      await context.whatsapp.sendMessage(from, 
        '👋 Has salido del modo de asesoría.\n\nVolviendo al menú principal...'
      );
      // Continuar al handler para mostrar menú
      stateManager.resetState(from, negocio.id);
    } else {
      // Guardar mensaje para el asesor y NO responder
      const conversacionId = await asesorService.obtenerConversacionId(from, context.sheets);
      if (conversacionId) {
        await asesorService.guardarMensaje(conversacionId, from, text, 'CLIENTE', context.sheets);
      }
      // Marcar como leído pero NO responder
      await context.whatsapp.markAsRead(messageId);
      return; // ← STOP - Bot no responde
    }
  }

  // Marcar como leído
  await context.whatsapp.markAsRead(messageId);

  // Guardar negocio activo en memoria Y en Sheets
  stateManager.setActiveBusiness(from, negocio.id);
  usuariosNegociosService.vincularUsuario(from, negocio.id).catch(console.error);

  const handler = customHandlers[negocio.id] || estandarHandler;

  if (!handler) {
    console.log('⚠️ No hay handler disponible');
    await context.whatsapp.sendMessage(from, 'Lo sentimos, el servicio no está disponible.');
    return;
  }

  try {
    await handler.handle(from, { text, mediaId, type, interactiveData, raw: message }, context);
  } catch (error) {
    console.error('❌ Error en handler:', error);
    await context.whatsapp.sendMessage(from, 'Ocurrió un error. Intenta nuevamente.');
  }
}

/**
 * Crear contexto para el handler
 * @param {Object} negocio - Datos del negocio
 * @param {boolean} useSharedCredentials - Si true, usa credenciales del número compartido
 */
async function createContext(negocio, useSharedCredentials = false) {
  // Determinar qué credenciales de WhatsApp usar
  let whatsappConfig;
  
  if (useSharedCredentials || negocio.whatsapp?.tipo === 'COMPARTIDO') {
    // Usar credenciales del número compartido (de variables de entorno)
    whatsappConfig = config.whatsappShared;
    console.log(`   📞 Usando WhatsApp COMPARTIDO (${config.whatsappShared.phoneId})`);
  } else {
    // Usar credenciales propias del negocio
    whatsappConfig = negocio.whatsapp;
    console.log(`   📞 Usando WhatsApp PROPIO (${negocio.whatsapp?.phoneId})`);
  }

  const whatsapp = new WhatsAppService(whatsappConfig);
  const sheets = new SheetsService(negocio.spreadsheetId);
  await sheets.initialize();

  // Wrapper para registrar mensajes del bot
  const originalSendMessage = whatsapp.sendMessage.bind(whatsapp);
  whatsapp.sendMessage = async (to, message) => {
    const result = await originalSendMessage(to, message);
    // Registrar mensaje del bot
    try {
      await mensajeLogger.logMensajeBot(to, message, sheets);
    } catch (e) {}
    return result;
  };

  return {
    negocio,
    whatsapp,
    sheets,
    stateManager,
    asesorService, // ← Exponer servicio de asesor a los handlers
    hasFeature: (feature) => negocio.features.includes(feature),
    config: negocio.configExtra || {}
  };
}

function extractMessage(body) {
  try {
    return body.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
  } catch {
    return null;
  }
}

function extractMessageContent(message) {
  let text = '';
  let mediaId = null;
  let interactiveData = null;
  const type = message.type;

  switch (type) {
    case 'text':
      text = message.text?.body || '';
      break;
    case 'image':
      text = message.image?.caption || '';
      mediaId = message.image?.id;
      break;
    case 'interactive':
      if (message.interactive?.type === 'button_reply') {
        text = message.interactive.button_reply.title;
        interactiveData = { type: 'button', id: message.interactive.button_reply.id, title: text };
      } else if (message.interactive?.type === 'list_reply') {
        text = message.interactive.list_reply.title;
        interactiveData = { type: 'list', id: message.interactive.list_reply.id, title: text };
      }
      break;
    case 'order':
      const items = message.order?.product_items || [];
      interactiveData = { type: 'order', items: items.map(i => ({ productId: i.product_retailer_id, quantity: i.quantity, price: i.item_price })) };
      text = `ORDER:${items.length}`;
      break;
    default:
      text = `[${type}]`;
  }

  return { text, mediaId, type, interactiveData };
}

/**
 * Identificar negocio del usuario
 * Orden de prioridad:
 * 1. Selección de botón (select_xxx)
 * 2. Prefijo en mensaje (PLANTAS, ROSAL, etc.)
 * 3. Negocio guardado en Sheets (persistente)
 * 4. Negocio en memoria (stateManager)
 * 5. Si solo hay 1 negocio compartido, usar ese
 * 6. NUEVO: Negocio por defecto (BIZ-002 - Finca Rosal)
 */
async function identificarNegocio(from, message) {
  const text = message.text?.body || message.interactive?.button_reply?.id || '';
  const textUpper = text.toUpperCase().trim();
  
  // 1. Selección directa por botón
  if (text.startsWith('select_')) {
    const businessId = text.replace('select_', '');
    const negocio = negociosService.getById(businessId);
    if (negocio) {
      console.log(`   → Selección por botón: ${businessId}`);
      // Guardar vinculación
      await usuariosNegociosService.vincularUsuario(from, businessId);
      return negocio;
    }
  }

  // 2. Prefijo en mensaje (para links directos)
  for (const [prefijo, negocioId] of Object.entries(PREFIJOS_NEGOCIOS)) {
    if (textUpper === prefijo || textUpper.startsWith(prefijo + ' ')) {
      const negocio = negociosService.getById(negocioId);
      if (negocio) {
        console.log(`   → Prefijo detectado: ${prefijo} -> ${negocioId}`);
        // Guardar vinculación
        await usuariosNegociosService.vincularUsuario(from, negocioId);
        return negocio;
      }
    }
  }

  // 3. Buscar en Sheets (persistente)
  const negocioGuardado = await usuariosNegociosService.getNegocioUsuario(from);
  if (negocioGuardado) {
    const negocio = negociosService.getById(negocioGuardado);
    if (negocio) {
      console.log(`   → Negocio guardado en Sheets: ${negocioGuardado}`);
      return negocio;
    }
  }

  // 4. Buscar en memoria (stateManager)
  const activeBusinessId = stateManager.getActiveBusiness(from);
  if (activeBusinessId) {
    const negocio = negociosService.getById(activeBusinessId);
    if (negocio) {
      console.log(`   → Negocio en memoria: ${activeBusinessId}`);
      return negocio;
    }
  }

  // 5. Si solo hay 1 negocio compartido, usar ese
  const negocios = negociosService.getSharedNegocios();
  if (negocios.length === 1) {
    console.log(`   → Único negocio compartido: ${negocios[0].id}`);
    return negocios[0];
  }

  // 6. NUEVO: Negocio por defecto (BIZ-002 - Finca Rosal)
  const negocioPorDefecto = negociosService.getById(DEFAULT_BUSINESS_ID);
  if (negocioPorDefecto) {
    console.log(`   → Asignando negocio por defecto: ${negocioPorDefecto.nombre} (${DEFAULT_BUSINESS_ID})`);
    // Guardar vinculación para próximas veces
    await usuariosNegociosService.vincularUsuario(from, DEFAULT_BUSINESS_ID);
    return negocioPorDefecto;
  }

  // No se pudo identificar
  console.log(`   → No se identificó negocio`);
  return null;
}

/**
 * Mostrar selector de negocios
 */
async function mostrarSelectorNegocios(from) {
  const negocios = negociosService.getSharedNegocios();
  if (negocios.length === 0) return;

  const whatsapp = new WhatsAppService(config.whatsappShared);
  
  const mensaje = '¡Hola! 👋\n\n¿Con qué tienda deseas comunicarte?\n\n_Esta será tu tienda por defecto. Escribe "cambiar tienda" para elegir otra._';
  
  const botones = negocios.slice(0, 3).map(n => ({
    id: `select_${n.id}`,
    title: n.nombre.substring(0, 20)
  }));

  await whatsapp.sendButtonMessage(from, mensaje, botones);
}

router.initializeHandlers = initializeHandlers;

module.exports = router;
