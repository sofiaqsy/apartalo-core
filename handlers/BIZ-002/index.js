/**
 * APARTALO CORE - Handler Custom: BIZ-002 (Finca Rosal)
 * 
 * Flujo personalizado para Finca Rosal:
 * - Asesor humano (usa servicio común asesorService)
 * - Café gratis (muestra)
 * - Pedido mínimo 5kg
 * 
 * NOTA: El modo asesor se verifica en webhook-router ANTES de llegar aquí.
 * Si estado es ACTIVA, este handler NO se ejecuta.
 */

const { formatPrice, getGreeting, generateId } = require('../../core/utils/formatters');

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
  const { whatsapp, sheets, stateManager, negocio, hasFeature, asesorService } = context;
  const { text, type, interactiveData } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeUpper = mensajeLimpio.toUpperCase();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('HANDLER BIZ-002 (Finca Rosal)');
  console.log(`   From: ${from}`);
  console.log(`   Mensaje: "${mensajeLimpio}"`);
  console.log(`   Estado: ${state.step}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

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
    if (TRIGGERS_CAFE_GRATIS.some(t => mensajeUpper.includes(t))) {
      return await procesarCafeGratis(from, context);
    }

    if (state.step && state.step.startsWith('cafe_gratis_')) {
      return await continuarFlujoCafeGratis(from, mensajeLimpio, context);
    }
  }

  // ============================================
  // CONTACTAR FINCA / ASESOR (usa servicio común)
  // ============================================
  if (mensajeLimpio.toLowerCase().includes('contactar') || 
      mensajeLimpio.toLowerCase().includes('asesor') ||
      mensajeLimpio.toLowerCase() === 'finca') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      if (resultado.success) {
        await whatsapp.sendMessage(from, resultado.mensaje);
      } else {
        await whatsapp.sendMessage(from, resultado.mensaje || 'Error conectando con asesor.');
      }
      return;
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
  const { whatsapp, sheets, stateManager, negocio } = context;

  let cliente = null;
  let pedidosActivos = [];
  
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}
  
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = (pedidos || []).filter(p => 
      !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado)
    );
  } catch (e) {}

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
      `Bienvenido de vuelta a *Finca Rosal*\n\n` +
      `¿Qué deseas hacer?`;

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
  const { asesorService, whatsapp } = context;
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('pedir') || opcion === 'pedir') {
    return await mostrarCatalogo(from, context);
  }

  if (opcion.includes('repetir') || opcion === 'repetir') {
    return await mostrarHistorialPedidos(from, context);
  }

  if (opcion.includes('pedido') || opcion === 'ver_pedidos') {
    return await mostrarPedidosActivos(from, context);
  }

  if (opcion.includes('contactar') || opcion === 'contactar') {
    // Usar servicio común de asesor
    if (asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      if (resultado.success) {
        await whatsapp.sendMessage(from, resultado.mensaje);
      }
      return;
    }
  }

  return await mostrarMenuPrincipal(from, context);
}

// ============================================
// CATÁLOGO
// ============================================

async function mostrarCatalogo(from, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  let productos = [];
  try {
    productos = await sheets.getProductos('ACTIVO');
  } catch (e) {}
  
  if (!productos || productos.length === 0) {
    await whatsapp.sendMessage(from, 'No hay productos disponibles en este momento.');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `☕ *CATÁLOGO FINCA ROSAL*\n\n`;

  productos.forEach((p, i) => {
    mensaje += `*${i + 1}.* ${p.nombre}\n`;
    mensaje += `   S/${p.precio}/kg\n`;
    if (p.descripcion) mensaje += `   _${p.descripcion}_\n`;
    mensaje += '\n';
  });

  mensaje += `📦 Pedido mínimo: 5kg\n\n`;
  mensaje += `Escribe el *número* del café que deseas:`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.setState(from, negocio.id, {
    step: 'seleccion_producto',
    data: { productos }
  });
}

async function manejarSeleccionProducto(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productos } = state.data || {};

  if (!productos) {
    return await mostrarCatalogo(from, context);
  }

  const numero = parseInt(text);

  if (isNaN(numero) || numero < 1 || numero > productos.length) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa un número válido del catálogo.');
    return;
  }

  const producto = productos[numero - 1];

  let mensaje = `✅ Has seleccionado:\n\n`;
  mensaje += `*${producto.nombre}*\n`;
  if (producto.descripcion) mensaje += `${producto.descripcion}\n`;
  mensaje += `\nPrecio: S/${producto.precio}/kg\n\n`;
  mensaje += `*¿Cuántos kilos necesitas?*\n`;
  mensaje += `_Pedido mínimo: 5kg_`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.updateData(from, negocio.id, { 
    productoSeleccionado: producto,
    precioFinal: producto.precio
  });
  stateManager.setStep(from, negocio.id, 'cantidad');
}

async function manejarCantidad(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, precioFinal } = state.data || {};

  if (!productoSeleccionado) {
    return await mostrarCatalogo(from, context);
  }

  const cantidad = parseFloat(text);
  const minimo = 5;

  if (isNaN(cantidad) || cantidad < minimo) {
    await whatsapp.sendMessage(from, `El pedido mínimo es de *${minimo}kg*. Por favor, ingresa una cantidad mayor.`);
    return;
  }

  const total = cantidad * precioFinal;

  const mensaje = `*RESUMEN DE PEDIDO*\n\n` +
    `☕ ${productoSeleccionado.nombre}\n` +
    `   Cantidad: *${cantidad}kg*\n` +
    `   Precio: S/${precioFinal}/kg\n\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `*TOTAL: S/${total.toFixed(2)}*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `*¿Confirmar pedido?*`;

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Sí, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.updateData(from, negocio.id, { cantidad, total });
  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

// ============================================
// CONFIRMACIÓN Y DATOS
// ============================================

async function manejarConfirmacion(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const opcion = (text || '').toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado.');
    return await mostrarMenuPrincipal(from, context);
  }

  if (!opcion.includes('sí') && !opcion.includes('si') && opcion !== 'confirmar_si') {
    return;
  }

  let cliente = null;
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}

  if (cliente?.empresa && cliente?.direccion) {
    return await crearPedidoDirecto(from, context, cliente);
  }

  await whatsapp.sendMessage(from,
    `*DATOS DEL CLIENTE*\n\n` +
    `Por favor, ingresa el *nombre de tu empresa o negocio*:`
  );
  stateManager.setStep(from, negocio.id, 'datos_empresa');
}

async function manejarDatosEmpresa(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  stateManager.updateData(from, negocio.id, { empresa: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Empresa: *${text}*\n\n` +
    `Ahora ingresa la *dirección completa de tu cafetería*:\n` +
    `_Incluye distrito y referencia_`
  );
  stateManager.setStep(from, negocio.id, 'datos_direccion');
}

async function manejarDatosDireccion(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  stateManager.updateData(from, negocio.id, { direccion: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Dirección: *${text}*\n\n` +
    `¿Cuál es tu *nombre completo*?`
  );
  stateManager.setStep(from, negocio.id, 'datos_contacto');
}

async function manejarDatosContacto(from, text, context) {
  const { whatsapp, stateManager, negocio } = context;
  stateManager.updateData(from, negocio.id, { contacto: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Contacto: *${text}*\n\n` +
    `Por último, ingresa un *número de teléfono* para coordinar la entrega:`
  );
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

  try {
    await sheets.upsertCliente(datosCliente);
  } catch (e) {}

  return await crearPedidoDirecto(from, context, datosCliente);
}

async function crearPedidoDirecto(from, context, cliente) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, cantidad, total, precioFinal } = state.data || {};

  if (!productoSeleccionado) {
    return await mostrarMenuPrincipal(from, context);
  }

  const pedidoId = generateId('CAF');

  try {
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
  } catch (e) {}

  const mensaje = `✅ *¡Pedido recibido!*\n\n` +
    `☕ *${productoSeleccionado.nombre}*\n` +
    `${cantidad}kg - S/${total.toFixed(2)}\n\n` +
    `Tu código de pedido es *${pedidoId}* y será entregado en:\n` +
    `*${cliente.direccion}*\n\n` +
    `En las próximas horas te contactaremos para coordinar el pago.\n\n` +
    `¡Gracias por tu confianza! ☕`;

  await whatsapp.sendMessage(from, mensaje);
  stateManager.resetState(from, negocio.id);
}

// ============================================
// CAFÉ GRATIS
// ============================================

async function procesarCafeGratis(from, context) {
  const { whatsapp, stateManager, negocio } = context;

  await whatsapp.sendMessage(from,
    `🎁 *¡MUESTRA GRATIS!*\n\n` +
    `Gracias por tu interés en nuestro café.\n\n` +
    `Para solicitar tu muestra gratis de 250g, necesitamos algunos datos.\n\n` +
    `¿Cuál es el *nombre de tu cafetería o negocio*?`
  );

  stateManager.setState(from, negocio.id, {
    step: 'cafe_gratis_empresa',
    data: { tipo: 'MUESTRA' }
  });
}

async function continuarFlujoCafeGratis(from, text, context) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  switch (state.step) {
    case 'cafe_gratis_empresa':
      stateManager.updateData(from, negocio.id, { empresa: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *nombre completo*?');
      stateManager.setStep(from, negocio.id, 'cafe_gratis_nombre');
      break;

    case 'cafe_gratis_nombre':
      stateManager.updateData(from, negocio.id, { nombre: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *dirección completa* para el envío?\n_Incluye distrito_');
      stateManager.setStep(from, negocio.id, 'cafe_gratis_direccion');
      break;

    case 'cafe_gratis_direccion':
      stateManager.updateData(from, negocio.id, { direccion: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *número de teléfono*?');
      stateManager.setStep(from, negocio.id, 'cafe_gratis_telefono');
      break;

    case 'cafe_gratis_telefono':
      const data = state.data;
      data.telefono = text;

      const pedidoId = generateId('MUE');
      
      try {
        await sheets.crearPedido({
          id: pedidoId,
          whatsapp: from,
          cliente: data.empresa,
          telefono: data.telefono,
          direccion: data.direccion,
          productos: 'Muestra Café 250g',
          total: 0,
          estado: 'Pendiente envío',
          observaciones: 'MUESTRA GRATIS'
        });
      } catch (e) {}

      await whatsapp.sendMessage(from,
        `✅ *¡MUESTRA SOLICITADA!*\n\n` +
        `Tu código es *${pedidoId}*\n\n` +
        `Enviaremos tu muestra de 250g de café a:\n` +
        `*${data.direccion}*\n\n` +
        `Te contactaremos para coordinar la entrega.\n\n` +
        `¡Gracias por tu interés en Finca Rosal! ☕`
      );

      stateManager.resetState(from, negocio.id);
      break;
  }
}

// ============================================
// UTILIDADES
// ============================================

async function mostrarPedidosActivos(from, context) {
  const { whatsapp, sheets } = context;

  let activos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    activos = (pedidos || []).filter(p => !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado));
  } catch (e) {}

  if (activos.length === 0) {
    await whatsapp.sendMessage(from, 'No tienes pedidos activos.');
    return await mostrarMenuPrincipal(from, context);
  }

  let mensaje = `*📋 TUS PEDIDOS ACTIVOS*\n\n`;
  activos.forEach(p => {
    mensaje += `*${p.id}*\n`;
    mensaje += `   Estado: ${p.estado}\n`;
    mensaje += `   Total: S/${p.total}\n\n`;
  });

  await whatsapp.sendMessage(from, mensaje);
}

async function mostrarHistorialPedidos(from, context) {
  const { whatsapp } = context;
  await whatsapp.sendMessage(from, 'Función de repetir pedido próximamente. Aquí está nuestro catálogo:');
  return await mostrarCatalogo(from, context);
}

module.exports = { handle };
