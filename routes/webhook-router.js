/**
 * APARTALO CORE - Webhook Router
 * 
 * Enruta mensajes de WhatsApp al handler correcto según:
 * - Negocios con número PROPIO: webhook específico
 * - Negocios con número COMPARTIDO: identifica por contexto
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const negociosService = require('../config/negocios');
const stateManager = require('../core/services/state-manager');
const WhatsAppService = require('../core/services/whatsapp-service');
const SheetsService = require('../core/services/sheets-service');

// Handlers
let estandarHandler = null;
const customHandlers = {};

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

    await processWebhook(body, negocio);
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
    let negocio = await identificarNegocio(from, message);

    if (!negocio) {
      await mostrarSelectorNegocios(from);
      return res.sendStatus(200);
    }

    await processWebhook(body, negocio);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en webhook compartido:', error);
    res.sendStatus(200);
  }
});

// ============================================
// PROCESAMIENTO
// ============================================

async function processWebhook(body, negocio) {
  if (!body.entry || body.entry.length === 0) return;

  for (const entry of body.entry) {
    if (!entry.changes || entry.changes.length === 0) continue;

    for (const change of entry.changes) {
      const value = change.value;

      if (value.messages && value.messages.length > 0) {
        for (const message of value.messages) {
          await processMessage(message, negocio);
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

async function processMessage(message, negocio) {
  const from = message.from;
  const messageId = message.id;

  console.log(`\n📱 Mensaje de ${from} para ${negocio.nombre}`);

  const context = await createContext(negocio);
  await context.whatsapp.markAsRead(messageId);

  const { text, mediaId, type, interactiveData } = extractMessageContent(message);

  console.log(`   Tipo: ${type}`);
  console.log(`   Texto: ${text}`);

  stateManager.setActiveBusiness(from, negocio.id);

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

async function createContext(negocio) {
  const whatsapp = new WhatsAppService(negocio.whatsapp);
  const sheets = new SheetsService(negocio.spreadsheetId);
  await sheets.initialize();

  return {
    negocio,
    whatsapp,
    sheets,
    stateManager,
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
  const activeBusinessId = stateManager.getActiveBusiness(from);
  if (activeBusinessId) {
    const negocio = negociosService.getById(activeBusinessId);
    if (negocio) return negocio;
  }

  const text = message.text?.body || message.interactive?.button_reply?.id || '';
  
  if (text.startsWith('select_')) {
    const businessId = text.replace('select_', '');
    return negociosService.getById(businessId);
  }

  const negocios = negociosService.getSharedNegocios();
  for (const negocio of negocios) {
    if (text.toUpperCase().includes(negocio.whatsapp.prefijo)) {
      return negocio;
    }
  }

  if (negocios.length === 1) return negocios[0];
  return null;
}

async function mostrarSelectorNegocios(from) {
  const negocios = negociosService.getSharedNegocios();
  if (negocios.length === 0) return;

  const whatsapp = new WhatsAppService(config.whatsappShared);
  const mensaje = '¡Hola! 👋\n\n¿Con qué tienda deseas comunicarte?';
  const botones = negocios.slice(0, 3).map(n => ({ id: `select_${n.id}`, title: n.nombre.substring(0, 20) }));

  await whatsapp.sendButtonMessage(from, mensaje, botones);
}

router.initializeHandlers = initializeHandlers;

module.exports = router;
