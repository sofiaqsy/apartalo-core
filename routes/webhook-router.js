/**
 * APARTALO CORE - Webhook Router
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
const firebaseService = require('../core/services/firebase-service');
const messageDebounce = require('../core/services/message-debounce');

// Handlers
let unificadoHandler = null;
let estandarHandler = null;
const customHandlers = {};

const PREFIJOS_NEGOCIOS = {
  'PLANTAS': 'plantas-vivero',
  'VIVERO': 'plantas-vivero',
  'ROSAL': 'BIZ-002',
  'TIENDA': 'BIZ-002',
  'CAFE': 'BIZ-002',
  'FINCA': 'BIZ-002'
};

const DEFAULT_BUSINESS_ID = 'BIZ-002';

// ============================================
// DEDUPLICACIÓN DE MENSAJES
// ============================================

// WhatsApp a veces re-envía el mismo webhook. Guardamos IDs procesados por 5 min.
const processedMessageIds = new Map(); // messageId -> timestamp
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  // Limpiar IDs viejos
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

async function initializeHandlers() {
  await negociosService.initialize();
  
  try {
    unificadoHandler = require('../handlers/unificado');
    console.log('✅ Handler UNIFICADO cargado (principal)');
  } catch (error) {
    console.log('⚠️ Handler unificado no disponible:', error.message);
  }

  try {
    estandarHandler = require('../handlers/estandar');
    console.log('✅ Handler estándar cargado (fallback)');
  } catch (error) {
    console.log('⚠️ Handler estándar no disponible:', error.message);
  }

  const negocios = negociosService.getAll();
  
  for (const negocio of negocios) {
    if (negocio.flujo === 'CUSTOM') {
      try {
        const handler = require(`../handlers/${negocio.id}`);
        if (handler && typeof handler.handle === 'function') {
          customHandlers[negocio.id] = handler;
          console.log(`✅ Handler custom cargado: ${negocio.id}`);
        }
      } catch (error) {
        console.log(`ℹ️ ${negocio.id} usará handler unificado`);
      }
    }
  }

  usuariosNegociosService.initialize().catch(console.error);
}

function getHandler(negocio) {
  const customHandler = customHandlers[negocio.id];
  if (customHandler && typeof customHandler.handle === 'function') {
    console.log(`   🔧 Usando handler CUSTOM: ${negocio.id}`);
    return customHandler;
  }
  if (unificadoHandler && typeof unificadoHandler.handle === 'function') {
    console.log(`   🔧 Usando handler UNIFICADO`);
    return unificadoHandler;
  }
  if (estandarHandler && typeof estandarHandler.handle === 'function') {
    console.log(`   🔧 Usando handler ESTÁNDAR (fallback)`);
    return estandarHandler;
  }
  return null;
}

async function getModoConversacion(businessId, whatsapp) {
  if (!firebaseService.initialized) return 'bot';
  try {
    const docRef = firebaseService.conversacionesRef(businessId).doc(whatsapp);
    const doc = await docRef.get();
    if (doc.exists) return doc.data().modo || 'bot';
    return 'bot';
  } catch (error) {
    console.log(`⚠️ Error obteniendo modo de Firebase: ${error.message}`);
    return 'bot';
  }
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

  res.json({ status: 'active', endpoint: 'webhook', businessId: req.params.businessId || 'shared', timestamp: new Date().toISOString() });
});

// ============================================
// WEBHOOK NÚMERO PROPIO
// ============================================

router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const negocio = negociosService.getById(businessId);
    if (!negocio) {
      console.log(`⚠️ Negocio no encontrado: ${businessId}`);
      return res.sendStatus(200);
    }

    await processWebhook(body, negocio, false);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    res.sendStatus(200);
  }
});

// ============================================
// WEBHOOK COMPARTIDO
// ============================================

router.post('/', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const message = extractMessage(body);
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body || message.interactive?.button_reply?.id || '';
    
    console.log(`\n📨 Webhook compartido: ${from}`);
    console.log(`   Mensaje: "${text}"`);

    if (text.toLowerCase() === 'cambiar tienda' || text.toLowerCase() === 'otra tienda') {
      await usuariosNegociosService.desvincularUsuario(from);
      stateManager.clearActiveBusiness(from);
      await mostrarSelectorNegocios(from);
      return res.sendStatus(200);
    }

    let negocio = await identificarNegocio(from, message);

    if (!negocio) {
      console.log('❌ No se pudo identificar negocio, enviando selector...');
      await mostrarSelectorNegocios(from);
      return res.sendStatus(200);
    }

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
          // Encolar con debounce — no await aquí para responder 200 rápido
          enqueueMessage(message, negocio, useSharedCredentials);
        }
      }
    }
  }
}

/**
 * Encola el mensaje con debounce.
 * Si el usuario envía varios mensajes seguidos, se concatenan y se procesan una sola vez.
 */
function enqueueMessage(message, negocio, useSharedCredentials) {
  const from = message.from;
  const messageId = message.id;

  // Dedup: ignorar si este message ID ya fue procesado (WhatsApp re-envía webhooks)
  if (isDuplicateMessage(messageId)) {
    console.log(`   ⚡ Mensaje duplicado ignorado: ${messageId}`);
    return;
  }

  const { text, mediaId, type, interactiveData } = extractMessageContent(message);

  // Para mensajes no-texto (imagen, audio, botón) procesamos sin esperar debounce adicional
  // porque no hay texto complementario útil que esperar
  const esTexto = type === 'text';

  if (!esTexto) {
    // Procesar directo, sin debounce
    processMessage(message, negocio, useSharedCredentials, text).catch(console.error);
    return;
  }

  // Debounce: esperar a que el usuario termine de escribir
  messageDebounce.enqueue(negocio.id, from, text).then((textoAgrupado) => {
    // Construir mensaje virtual con el texto acumulado
    const mensajeAgrupado = {
      ...message,
      text: { body: textoAgrupado }
    };
    processMessage(mensajeAgrupado, negocio, useSharedCredentials, textoAgrupado).catch(console.error);
  });
}

async function processMessage(message, negocio, useSharedCredentials = false, textOverride = null) {
  const from = message.from;
  const messageId = message.id;

  if (!negocio || !negocio.nombre) {
    console.error('❌ Error: negocio es null o inválido');
    return;
  }

  console.log(`\n📱 Mensaje de ${from} para ${negocio.nombre}`);

  const context = await createContext(negocio, useSharedCredentials);
  
  const { text: textExtraido, mediaId, type, interactiveData } = extractMessageContent(message);
  const text = textOverride !== null ? textOverride : textExtraido;

  console.log(`   Tipo: ${type}`);
  console.log(`   Texto: "${text}"`);

  let nombreCliente = 'Cliente';
  try {
    const cliente = await context.sheets.buscarCliente(from);
    if (cliente) {
      nombreCliente = cliente.contacto || cliente.empresa || cliente.nombre || 'Cliente';
    }
  } catch (e) {}

  // Guardar en Firestore
  try {
    await firebaseService.guardarMensaje(negocio.id, from, {
      texto: text || `[${type}]`,
      origen: 'cliente',
      tipo: type,
      nombreCliente,
      mediaUrl: mediaId ? `media:${mediaId}` : null
    });
    console.log(`   🔥 Mensaje guardado en Firestore`);
  } catch (e) {
    console.log(`   ⚠️ Error guardando en Firestore: ${e.message}`);
  }

  // Verificar modo
  const modoConversacion = await getModoConversacion(negocio.id, from);
  console.log(`   🎯 Modo conversación: ${modoConversacion}`);
  
  const botDebeResponder = (modoConversacion === 'bot');
  
  if (!botDebeResponder) {
    console.log(`👤 MODO ${modoConversacion.toUpperCase()} - Bot NO responde automáticamente`);
    
    await firebaseService.notificarMensajeSoporte(negocio.id, {
      whatsapp: from,
      nombreCliente,
      texto: text || `[${type}]`
    });
    
    const textLower = (text || '').toLowerCase().trim();
    if (textLower === 'menu' || textLower === 'menú' || textLower === 'salir' || textLower === 'bot') {
      await firebaseService.cambiarModo(negocio.id, from, 'bot');
      console.log(`   ✅ Modo cambiado a BOT`);
      await context.whatsapp.sendMessage(from, 'Has vuelto al modo automático.\n\nVolviendo al menú principal...');
      await context.whatsapp.markAsRead(messageId);
      stateManager.resetState(from, negocio.id);
    } else {
      try {
        await mensajeLogger.logMensajeCliente(from, text || `[${type}]`, context.sheets);
      } catch (e) {}
      return;
    }
  } else {
    try {
      await mensajeLogger.logMensajeCliente(from, text || `[${type}]`, context.sheets);
    } catch (e) {
      console.log('⚠️ Error logging mensaje:', e.message);
    }
  }

  await context.whatsapp.markAsRead(messageId);

  stateManager.setActiveBusiness(from, negocio.id);
  usuariosNegociosService.vincularUsuario(from, negocio.id).catch(console.error);

  const handler = getHandler(negocio);

  if (!handler) {
    console.log('⚠️ No hay handler disponible');
    await context.whatsapp.sendMessage(from, 'Lo sentimos, el servicio no está disponible.');
    return;
  }

  // ── Delivery button reply intercept ─────────────────────────────────────
  if (interactiveData?.id?.startsWith('delivery_yes_')) {
    const deliveryService = require('../core/services/delivery-service');
    try {
      await deliveryService.asignarDelivery(from, interactiveData.id, context);
    } catch (e) {
      console.error('❌ Error en asignarDelivery:', e.message);
    }
    return;
  }

  try {
    await handler.handle(from, { text, mediaId, type, interactiveData, raw: message }, context);
  } catch (error) {
    console.error('❌ Error en handler:', error);
    await context.whatsapp.sendMessage(from, 'Ocurrió un error. Intenta nuevamente.');
  }
}

async function createContext(negocio, useSharedCredentials = false) {
  let whatsappConfig;
  
  if (useSharedCredentials || negocio.whatsapp?.tipo === 'COMPARTIDO') {
    whatsappConfig = config.whatsappShared;
    console.log(`   📞 Usando WhatsApp COMPARTIDO (${config.whatsappShared.phoneId})`);
  } else {
    whatsappConfig = negocio.whatsapp;
    console.log(`   📞 Usando WhatsApp PROPIO (${negocio.whatsapp?.phoneId})`);
  }

  const whatsapp = new WhatsAppService(whatsappConfig);
  const sheets = new SheetsService(negocio.spreadsheetId);
  await sheets.initialize();

  const originalSendMessage = whatsapp.sendMessage.bind(whatsapp);
  whatsapp.sendMessage = async (to, message) => {
    const result = await originalSendMessage(to, message);
    try { await mensajeLogger.logMensajeBot(to, message, sheets); } catch (e) {}
    try {
      await firebaseService.guardarMensaje(negocio.id, to, { texto: message, origen: 'bot', tipo: 'text' });
    } catch (e) {}
    return result;
  };

  return {
    negocio,
    whatsapp,
    sheets,
    stateManager,
    asesorService,
    firebaseService,
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

async function identificarNegocio(from, message) {
  const text = message.text?.body || message.interactive?.button_reply?.id || '';
  const textUpper = text.toUpperCase().trim();
  
  if (text.startsWith('select_')) {
    const businessId = text.replace('select_', '');
    const negocio = negociosService.getById(businessId);
    if (negocio) {
      console.log(`   → Selección por botón: ${businessId}`);
      await usuariosNegociosService.vincularUsuario(from, businessId);
      return negocio;
    }
  }

  for (const [prefijo, negocioId] of Object.entries(PREFIJOS_NEGOCIOS)) {
    if (textUpper === prefijo || textUpper.startsWith(prefijo + ' ')) {
      const negocio = negociosService.getById(negocioId);
      if (negocio) {
        console.log(`   → Prefijo detectado: ${prefijo} -> ${negocioId}`);
        await usuariosNegociosService.vincularUsuario(from, negocioId);
        return negocio;
      }
    }
  }

  const negocioGuardado = await usuariosNegociosService.getNegocioUsuario(from);
  if (negocioGuardado) {
    const negocio = negociosService.getById(negocioGuardado);
    if (negocio) {
      console.log(`   → Negocio guardado en Sheets: ${negocioGuardado}`);
      return negocio;
    }
  }

  const activeBusinessId = stateManager.getActiveBusiness(from);
  if (activeBusinessId) {
    const negocio = negociosService.getById(activeBusinessId);
    if (negocio) {
      console.log(`   → Negocio en memoria: ${activeBusinessId}`);
      return negocio;
    }
  }

  const negocios = negociosService.getSharedNegocios();
  if (negocios.length === 1) {
    console.log(`   → Único negocio compartido: ${negocios[0].id}`);
    return negocios[0];
  }

  const negocioPorDefecto = negociosService.getById(DEFAULT_BUSINESS_ID);
  if (negocioPorDefecto) {
    console.log(`   → Asignando negocio por defecto: ${negocioPorDefecto.nombre}`);
    await usuariosNegociosService.vincularUsuario(from, DEFAULT_BUSINESS_ID);
    return negocioPorDefecto;
  }

  return null;
}

async function mostrarSelectorNegocios(from) {
  const negocios = negociosService.getSharedNegocios();
  if (negocios.length === 0) return;

  const whatsapp = new WhatsAppService(config.whatsappShared);
  const mensaje = '¡Hola! ¿Con qué tienda deseas comunicarte?\n\n_Escribe "cambiar tienda" para elegir otra._';
  const botones = negocios.slice(0, 3).map(n => ({ id: `select_${n.id}`, title: n.nombre.substring(0, 20) }));

  await whatsapp.sendButtonMessage(from, mensaje, botones);
}

router.initializeHandlers = initializeHandlers;

module.exports = router;
