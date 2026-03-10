/**
 * APARTALO CORE - Handler Custom: Finca Rosal
 *
 * Flujo personalizado para Finca Rosal:
 * - Asesor humano
 * - Precios VIP por cliente
 * - Café gratis (muestra) — gestionado por ai-muestra-service (conversacional)
 * - Pedido mínimo 5kg
 */

const { formatPrice, getGreeting, generateId } = require('../../core/utils/formatters');
const config = require('../../config');
const aiMuestraService = require('../../core/services/ai-muestra-service');

// Triggers para café gratis
const TRIGGERS_CAFE_GRATIS = [
  'SOLICITO MUESTRA',
  'SOLICITAR MUESTRA',
  'MUESTRA GRATIS',
  'PROMOCAFE',
  'PROMO1KG',
  'QUIERO UNA MUESTRA GRATIS'
];

/**
 * Manejar mensaje entrante
 */
async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;
  const { text, type, interactiveData } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeUpper = mensajeLimpio.toUpperCase();

  console.log(`   Estado: ${state.step}`);
  console.log(`   Features: ${negocio.features.join(', ')}`);

  // ============================================
  // MODO ASESOR - Tiene prioridad absoluta
  // ============================================
  if (hasFeature('asesorHumano')) {
    const estadoAsesor = await verificarModoAsesor(from, context);

    if (estadoAsesor === 'ACTIVA') {
      await guardarMensajeAsesor(from, mensajeLimpio, 'CLIENTE', context);

      if (mensajeLimpio.toLowerCase() === 'menu' || mensajeLimpio.toLowerCase() === 'salir') {
        await cerrarConversacionAsesor(from, context);
        return await mostrarMenuPrincipal(from, context);
      }

      console.log('👤 Mensaje guardado para asesor - BOT NO RESPONDE');
      return;
    }
  }

  // ============================================
  // COMANDOS GLOBALES
  // ============================================
  if (mensajeLimpio.toLowerCase() === 'menu' || mensajeLimpio.toLowerCase() === 'menú') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context);
  }

  // ============================================
  // CAFÉ GRATIS
  // ============================================
  if (hasFeature('cafeGratis')) {
    // Trigger detected — start (or re-enter) the AI muestra flow
    if (TRIGGERS_CAFE_GRATIS.some(t => mensajeUpper.includes(t))) {
      // Pass the original message to the AI: the client may have included their
      // company name or product preference in the trigger sentence, e.g.
      // "Quiero una muestra gratis de Café Blend de Típico, Caturra, Pache"
      return await procesarCafeGratis(from, mensajeLimpio, context);
    }

    // Continue AI muestra flow if active
    if (state.step === 'cafe_gratis_ai') {
      return await continuarFlujoCafeGratis(from, mensajeLimpio, context);
    }
  }

  // ============================================
  // CONTACTAR FINCA / ASESOR
  // ============================================
  if (mensajeLimpio.toLowerCase().includes('contactar') ||
      mensajeLimpio.toLowerCase().includes('asesor') ||
      mensajeLimpio.toLowerCase() === 'finca') {
    if (hasFeature('asesorHumano')) {
      return await activarModoAsesor(from, context);
    }
  }

  // ============================================
  // FLUJO NORMAL DE PEDIDOS
  // ============================================
  switch (state.step) {
    case 'inicio':
      return await mostrarMenuPrincipal(from, context);
    case 'menu':
      return await manejarMenu(from, text, interactiveData, context);
    case 'seleccion_producto':
      return await manejarSeleccionProducto(from, text, context);
    case 'cantidad':
      return await manejarCantidad(from, text, context);
    case 'confirmar_pedido':
      return await manejarConfirmacion(from, text, context);
    case 'datos_empresa':
      return await manejarDatosEmpresa(from, text, context);
    case 'datos_direccion':
      return await manejarDatosDireccion(from, text, context);
    case 'datos_contacto':
      return await manejarDatosContacto(from, text, context);
    case 'datos_telefono':
      return await manejarDatosTelefono(from, text, context);
    default:
      return await mostrarMenuPrincipal(from, context);
  }
}

// ============================================
// MENÚ PRINCIPAL
// ============================================

async function mostrarMenuPrincipal(from, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;

  const cliente = await sheets.buscarCliente(from);
  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const pedidosActivos = pedidos.filter(p =>
    !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado)
  );

  const saludo = getGreeting();
  let mensaje = '';
  let botones = [];

  if (!cliente && pedidosActivos.length === 0) {
    mensaje = `${saludo}! 👋\n\nBienvenido a *Finca Rosal*\n\n` +
      `Ofrecemos café orgánico premium de Villa Rica directamente a tu cafetería.\n\n` +
      `¿Qué deseas hacer?`;
    botones = [
      { id: 'pedir', title: 'Hacer pedido' },
      { id: 'contactar', title: 'Contactar Finca' }
    ];
  } else if (pedidosActivos.length > 0) {
    mensaje = `${saludo}! Tienes ${pedidosActivos.length} pedido(s) activo(s):\n\n`;
    pedidosActivos.slice(0, 2).forEach(p => {
      mensaje += `• *${p.id}* - ${p.estado}\n`;
    });
    mensaje += `\n¿Qué deseas hacer?`;
    botones = [
      { id: 'ver_pedidos', title: 'Ver pedidos' },
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'contactar', title: 'Contactar Finca' }
    ];
  } else {
    const nombreCliente = cliente?.contacto || cliente?.empresa || '';
    mensaje = `${saludo}${nombreCliente ? ` ${nombreCliente}` : ''}! 👋\n\n` +
      `Bienvenido de vuelta a *Finca Rosal*\n\n¿Qué deseas hacer?`;
    botones = [
      { id: 'repetir', title: 'Volver a pedir' },
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'contactar', title: 'Contactar Finca' }
    ];
  }

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

async function manejarMenu(from, text, interactiveData, context) {
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('pedir') || opcion === 'pedir') return await mostrarCatalogo(from, context);
  if (opcion.includes('repetir') || opcion === 'repetir') return await mostrarHistorialPedidos(from, context);
  if (opcion.includes('pedido') || opcion === 'ver_pedidos') return await mostrarPedidosActivos(from, context);
  if (opcion.includes('contactar') || opcion === 'contactar') return await activarModoAsesor(from, context);

  return await mostrarMenuPrincipal(from, context);
}

// ============================================
// CATÁLOGO
// ============================================

async function mostrarCatalogo(from, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;

  const productos = await sheets.getProductos('ACTIVO');

  if (productos.length === 0) {
    await whatsapp.sendMessage(from, 'No hay productos disponibles en este momento.');
    return await mostrarMenuPrincipal(from, context);
  }

  let preciosVIP = {};
  if (hasFeature('preciosVIP')) {
    const cliente = await sheets.buscarCliente(from);
    if (cliente?.id) preciosVIP = {};
  }

  let mensaje = `☕ *CATÁLOGO FINCA ROSAL*\n\n`;
  productos.forEach((p, i) => {
    const precioFinal = preciosVIP[p.codigo] || p.precio;
    const descuento = preciosVIP[p.codigo] ? ` ~~S/${p.precio}~~` : '';
    mensaje += `*${i + 1}.* ${p.nombre}\n`;
    mensaje += `   S/${precioFinal}/kg${descuento}\n`;
    if (p.descripcion) mensaje += `   _${p.descripcion}_\n`;
    mensaje += '\n';
  });
  mensaje += `📦 Pedido mínimo: 5kg\n\nEscribe el *número* del café que deseas:`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.setState(from, negocio.id, {
    step: 'seleccion_producto',
    data: { productos, preciosVIP }
  });
}

async function manejarSeleccionProducto(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productos, preciosVIP } = state.data;

  const numero = parseInt(text);
  if (isNaN(numero) || numero < 1 || numero > productos.length) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa un número válido del catálogo.');
    return;
  }

  const producto = productos[numero - 1];
  const precioFinal = preciosVIP?.[producto.codigo] || producto.precio;

  let mensaje = `✅ Has seleccionado:\n\n*${producto.nombre}*\n`;
  if (producto.descripcion) mensaje += `${producto.descripcion}\n`;
  mensaje += `\nPrecio: S/${precioFinal}/kg\n\n*¿Cuántos kilos necesitas?*\n_Pedido mínimo: 5kg_`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.updateData(from, negocio.id, { productoSeleccionado: producto, precioFinal });
  stateManager.setStep(from, negocio.id, 'cantidad');
}

async function manejarCantidad(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, precioFinal } = state.data;

  const cantidad = parseFloat(text);
  const minimo = context.config?.deliveryMin || 5;

  if (isNaN(cantidad) || cantidad < minimo) {
    await whatsapp.sendMessage(from, `El pedido mínimo es de *${minimo}kg*. Por favor, ingresa una cantidad mayor.`);
    return;
  }

  const total = cantidad * precioFinal;
  const mensaje = `*RESUMEN DE PEDIDO*\n\n` +
    `☕ ${productoSeleccionado.nombre}\n   Cantidad: *${cantidad}kg*\n   Precio: S/${precioFinal}/kg\n\n` +
    `━━━━━━━━━━━━━━━━━\n*TOTAL: S/${total.toFixed(2)}*\n━━━━━━━━━━━━━━━━━\n\n*¿Confirmar pedido?*`;

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Sí, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.updateData(from, negocio.id, { cantidad, total });
  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

async function manejarConfirmacion(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const opcion = text.toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado.');
    return await mostrarMenuPrincipal(from, context);
  }

  if (!opcion.includes('sí') && !opcion.includes('si') && opcion !== 'confirmar_si') return;

  const cliente = await sheets.buscarCliente(from);
  if (cliente?.empresa && cliente?.direccion) return await crearPedidoDirecto(from, context, cliente);

  await whatsapp.sendMessage(from, `*DATOS DEL CLIENTE*\n\nPor favor, ingresa el *nombre de tu empresa o negocio*:`);
  stateManager.setStep(from, negocio.id, 'datos_empresa');
}

async function manejarDatosEmpresa(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  stateManager.updateData(from, negocio.id, { empresa: text });
  await whatsapp.sendMessage(from, `✅ Empresa: *${text}*\n\nAhora ingresa la *dirección completa de tu cafetería*:\n_Incluye distrito y referencia_`);
  stateManager.setStep(from, negocio.id, 'datos_direccion');
}

async function manejarDatosDireccion(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  stateManager.updateData(from, negocio.id, { direccion: text });
  await whatsapp.sendMessage(from, `✅ Dirección: *${text}*\n\n¿Cuál es tu *nombre completo*?`);
  stateManager.setStep(from, negocio.id, 'datos_contacto');
}

async function manejarDatosContacto(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  stateManager.updateData(from, negocio.id, { contacto: text });
  await whatsapp.sendMessage(from, `✅ Contacto: *${text}*\n\nPor último, ingresa un *número de teléfono* para coordinar la entrega:`);
  stateManager.setStep(from, negocio.id, 'datos_telefono');
}

async function manejarDatosTelefono(from, text, context) {
  const { sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const datosCliente = {
    whatsapp: from,
    nombre: state.data.contacto,
    telefono: text,
    direccion: state.data.direccion,
    empresa: state.data.empresa
  };

  await sheets.upsertCliente(datosCliente);
  return await crearPedidoDirecto(from, context, datosCliente);
}

async function crearPedidoDirecto(from, context, cliente) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, cantidad, total, precioFinal } = state.data;

  const pedidoId = generateId('CAF');

  await sheets.crearPedido({
    id: pedidoId,
    whatsapp: from,
    cliente: cliente.empresa || cliente.nombre,
    telefono: cliente.telefono,
    direccion: cliente.direccion,
    productos: JSON.stringify([{
      codigo: productoSeleccionado.codigo,
      nombre: productoSeleccionado.nombre,
      cantidad,
      precio: precioFinal
    }]),
    total,
    estado: 'En preparación'
  });

  await whatsapp.sendMessage(from,
    `✅ *¡Pedido recibido!*\n\n` +
    `☕ *${productoSeleccionado.nombre}*\n${cantidad}kg - S/${total.toFixed(2)}\n\n` +
    `Tu código de pedido es *${pedidoId}* y será entregado en:\n*${cliente.direccion}*\n\n` +
    `En las próximas horas te contactaremos para coordinar el pago y confirmar tu entrega.\n\n¡Gracias por tu confianza! ☕`
  );
  stateManager.resetState(from, negocio.id);
}

// ============================================
// MODO ASESOR
// ============================================

async function verificarModoAsesor(from, context) {
  const { sheets } = context;
  try {
    const rows = await sheets.getRows(sheets.spreadsheetId, 'Conversaciones_Asesor!A:E');
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    for (let i = 1; i < rows.length; i++) {
      const whatsappRow = (rows[i][3] || '').replace(/[^0-9]/g, '');
      if (whatsappRow === cleanFrom && (rows[i][4] || '') === 'ACTIVA') return 'ACTIVA';
    }
    return null;
  } catch (error) {
    console.error('Error verificando modo asesor:', error.message);
    return null;
  }
}

async function activarModoAsesor(from, context) {
  const { whatsapp, sheets } = context;
  try {
    const cliente = await sheets.buscarCliente(from);
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    const timestamp = new Date().toISOString();
    await sheets.appendRow('Conversaciones_Asesor', [
      `CONV-${Date.now()}`, timestamp,
      cliente?.empresa || cliente?.nombre || 'Cliente',
      cleanFrom, 'ACTIVA', timestamp
    ]);
    await whatsapp.sendMessage(from,
      `👤 *CONECTANDO CON FINCA ROSAL*\n\n` +
      `Un momento, te estamos conectando con un asesor.\n\n` +
      `Mientras tanto, puedes escribir tu consulta y te responderemos a la brevedad.\n\n` +
      `_Escribe "menu" para volver al menú principal_`
    );
    console.log(`✅ Modo asesor activado para ${from}`);
  } catch (error) {
    console.error('Error activando modo asesor:', error.message);
    await whatsapp.sendMessage(from, 'Error conectando con asesor. Intenta más tarde.');
  }
}

async function guardarMensajeAsesor(from, mensaje, tipo, context) {
  const { sheets } = context;
  try {
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    const rows = await sheets.getRows(sheets.spreadsheetId, 'Conversaciones_Asesor!A:E');
    let convId = null;
    for (let i = 1; i < rows.length; i++) {
      const whatsappRow = (rows[i][3] || '').replace(/[^0-9]/g, '');
      if (whatsappRow === cleanFrom && (rows[i][4] || '') === 'ACTIVA') {
        convId = rows[i][0];
        break;
      }
    }
    if (convId) {
      await sheets.appendRow('Mensajes', [
        `MSG-${Date.now()}`, convId, new Date().toISOString(), tipo, mensaje, cleanFrom
      ]);
    }
  } catch (error) {
    console.error('Error guardando mensaje asesor:', error.message);
  }
}

async function cerrarConversacionAsesor(from, context) {
  const { sheets } = context;
  try {
    const cleanFrom = from.replace('whatsapp:', '').replace('+', '').replace(/[^0-9]/g, '');
    const rows = await sheets.getRows(sheets.spreadsheetId, 'Conversaciones_Asesor!A:E');
    for (let i = 1; i < rows.length; i++) {
      const whatsappRow = (rows[i][3] || '').replace(/[^0-9]/g, '');
      if (whatsappRow === cleanFrom && (rows[i][4] || '') === 'ACTIVA') {
        await sheets.updateCell(`Conversaciones_Asesor!E${i + 1}`, 'CERRADA');
        console.log(`✅ Conversación cerrada para ${from}`);
        break;
      }
    }
  } catch (error) {
    console.error('Error cerrando conversación:', error.message);
  }
}

// ============================================
// CAFÉ GRATIS — AI-powered conversational flow
// ============================================

/**
 * Entry point when a TRIGGER_CAFE_GRATIS keyword is detected.
 * Passes the original trigger message to the AI so it can extract any
 * data the client already provided (e.g. product preference, business name).
 */
async function procesarCafeGratis(from, texto, context) {
  const { stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  // If the client is already in the AI muestra flow, keep going — don't restart.
  if (state.step === 'cafe_gratis_ai') {
    return await continuarFlujoCafeGratis(from, texto, context);
  }

  // Start a fresh muestra session.
  stateManager.setState(from, negocio.id, {
    step: 'cafe_gratis_ai',
    data: { tipo: 'MUESTRA', yaSePresento: false }
  });

  // Feed the trigger message to the AI straight away — it may already contain
  // useful data (company name, product type, etc.)
  return await continuarFlujoCafeGratis(from, texto, context);
}

/**
 * Handles every message while the client is in the AI muestra flow.
 * The AI service understands natural language so it correctly handles:
 *  - Conversational replies ("Hola, acabo de abrir una cafetería…")
 *  - Price / catalog questions ("¿cuánto cuesta el kilo?")
 *  - Data spread across multiple messages
 */
async function continuarFlujoCafeGratis(from, texto, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const yaSePresento = state.data?.yaSePresento || false;

  // Build an extended context so the AI service can access `context.from`
  const aiContext = { ...context, from };

  let resultado;
  try {
    resultado = await aiMuestraService.procesarMensajeMuestra(
      texto,
      aiContext,
      [],                    // historial: AI uses RAG context internally
      { whatsapp: from },    // datosCliente
      yaSePresento           // prevents re-introduction on every message
    );
  } catch (err) {
    console.error('Error llamando ai-muestra-service:', err.message);
    await whatsapp.sendMessage(from, 'Ocurrió un error. Por favor intenta de nuevo.');
    return;
  }

  // Mark bot as introduced after the first successful response
  if (!yaSePresento && !resultado.error) {
    stateManager.updateData(from, negocio.id, { yaSePresento: true });
  }

  // Send the AI-generated response to the client
  await whatsapp.sendMessage(from, resultado.respuesta);

  // If all required data has been collected, create the muestra order
  if (resultado.muestraCompleta && resultado.datosExtraidos) {
    await crearPedidoMuestra(from, resultado.datosExtraidos, context);
    stateManager.resetState(from, negocio.id);
  }
}

/**
 * Creates the muestra order in Google Sheets once the AI has collected all data.
 */
async function crearPedidoMuestra(from, datos, context) {
  const { sheets } = context;
  const pedidoId = generateId('MUE');

  // Persist client record if we have enough data
  if (datos.empresa || datos.nombre_contacto || datos.telefono || datos.direccion) {
    await sheets.upsertCliente({
      whatsapp: from,
      empresa: datos.empresa || '',
      nombre: datos.nombre_contacto || '',
      telefono: datos.telefono || '',
      direccion: datos.direccion || ''
    }).catch(e => console.log('Error guardando cliente muestra:', e.message));
  }

  await sheets.crearPedido({
    id: pedidoId,
    whatsapp: from,
    cliente: datos.empresa || datos.nombre_contacto || 'Cliente',
    telefono: datos.telefono || '',
    direccion: datos.direccion || '',
    productos: 'Muestra Café 500g',
    total: 0,
    estado: 'Pendiente envío',
    observaciones: 'MUESTRA GRATIS'
  });

  console.log(`✅ Pedido muestra creado: ${pedidoId} para ${from}`);
}

// ============================================
// UTILIDADES
// ============================================

async function mostrarPedidosActivos(from, context) {
  const { whatsapp, sheets } = context;
  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const activos = pedidos.filter(p => !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado));

  if (activos.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos activos.');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `*📋 TUS PEDIDOS ACTIVOS*\n\n`;
  activos.forEach(p => {
    mensaje += `*${p.id}*\n   Estado: ${p.estado}\n   Total: S/${p.total}\n   Fecha: ${p.fecha}\n\n`;
  });
  await whatsapp.sendMessage(from, mensaje);
}

async function mostrarHistorialPedidos(from, context) {
  const { whatsapp, sheets } = context;
  const pedidos = await sheets.getPedidosByWhatsapp(from);
  const completados = pedidos.filter(p => ['ENTREGADO', 'Completado'].includes(p.estado));

  if (completados.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos anteriores para repetir.');
    return await mostrarCatalogo(from, context);
  }

  await whatsapp.sendMessage(from, 'Función de repetir pedido próximamente. Mientras tanto, aquí está nuestro catálogo:');
  return await mostrarCatalogo(from, context);
}

module.exports = { handle };
