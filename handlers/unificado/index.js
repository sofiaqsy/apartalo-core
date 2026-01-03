/**
 * APARTALO CORE - Handler Unificado v1.0
 * 
 * Handler que combina lo mejor de BIZ-002 (flujo maduro) con mejoras del estándar.
 * 
 * CARACTERÍSTICAS:
 * - Flujo simple y directo (basado en BIZ-002)
 * - IA como apoyo (no dependencia)
 * - Configurable por negocio (unidad, mínimo, pago, etc.)
 * - Asesor humano integrado
 * - Fotos de productos
 * 
 * CONFIGURACIÓN (negocio.configExtra):
 * - unidad: 'kg' | 'unidad' (default: 'unidad')
 * - minimoCompra: número (default: 1)
 * - flujoPago: 'voucher' | 'contacto' (default: 'voucher')
 * - mostrarFotos: boolean (default: true)
 */

const { formatPrice, getGreeting, generateId } = require('../../core/utils/formatters');
const config = require('../../config');

/**
 * Manejar mensaje entrante
 */
async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature, asesorService } = context;
  const { text, type, interactiveData } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeNormalizado = mensajeLimpio.toLowerCase();

  // Configuración del negocio
  const cfg = {
    unidad: negocio.configExtra?.unidad || 'unidad',
    minimoCompra: negocio.configExtra?.minimoCompra || 1,
    flujoPago: negocio.configExtra?.flujoPago || 'voucher',
    mostrarFotos: negocio.configExtra?.mostrarFotos !== false,
    prefijoPedido: negocio.configExtra?.prefijoPedido || 'PED'
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`HANDLER UNIFICADO - ${negocio.nombre}`);
  console.log(`   From: ${from}`);
  console.log(`   Mensaje: "${mensajeLimpio}"`);
  console.log(`   Estado: ${state.step}`);
  console.log(`   Config: unidad=${cfg.unidad}, min=${cfg.minimoCompra}, pago=${cfg.flujoPago}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ============================================
  // COMANDOS GLOBALES
  // ============================================
  if (mensajeNormalizado === 'menu' || mensajeNormalizado === 'menú' || mensajeNormalizado === 'inicio') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  if (mensajeNormalizado === 'cancelar') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operación cancelada.');
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  // ============================================
  // TRIGGERS ESPECIALES (por features)
  // ============================================
  
  // Café gratis / Muestras
  if (hasFeature('cafeGratis') || hasFeature('muestras')) {
    const triggersMuestra = ['SOLICITO MUESTRA', 'SOLICITAR MUESTRA', 'MUESTRA GRATIS', 'PROMOCAFE', 'PROMO1KG'];
    if (triggersMuestra.some(t => mensajeLimpio.toUpperCase().includes(t))) {
      return await procesarMuestraGratis(from, context, cfg);
    }
    if (state.step?.startsWith('muestra_')) {
      return await continuarFlujoMuestra(from, mensajeLimpio, context, cfg);
    }
  }

  // ============================================
  // CONTACTAR ASESOR
  // ============================================
  if (mensajeNormalizado.includes('contactar') || 
      mensajeNormalizado.includes('asesor') ||
      mensajeNormalizado === 'ayuda') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      await whatsapp.sendMessage(from, 
        `*${negocio.nombre}*\n\n` +
        `Escribe tu consulta y te responderemos pronto.\n\n` +
        `_Escribe "menu" para volver_`
      );
      return;
    }
  }

  // ============================================
  // FLUJO PRINCIPAL
  // ============================================
  switch (state.step) {
    case 'inicio':
      return await mostrarMenuPrincipal(from, context, cfg);

    case 'menu':
      return await manejarMenu(from, text, interactiveData, context, cfg);

    case 'seleccion_producto':
      return await manejarSeleccionProducto(from, text, context, cfg);

    case 'cantidad':
      return await manejarCantidad(from, text, context, cfg);

    case 'confirmar_pedido':
      return await manejarConfirmacion(from, text, interactiveData, context, cfg);

    case 'datos_nombre':
      return await manejarDatosNombre(from, text, context, cfg);

    case 'datos_direccion':
      return await manejarDatosDireccion(from, text, context, cfg);

    case 'datos_telefono':
      return await manejarDatosTelefono(from, text, context, cfg);

    case 'esperando_voucher':
      return await manejarVoucher(from, message, context, cfg);

    default:
      return await mostrarMenuPrincipal(from, context, cfg);
  }
}

// ============================================
// MENÚ PRINCIPAL
// ============================================

async function mostrarMenuPrincipal(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature } = context;

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

  // Usuario nuevo sin pedidos
  if (!cliente && pedidosActivos.length === 0) {
    mensaje = `${saludo}! 👋\n\nBienvenido a *${negocio.nombre}*\n\n¿Qué deseas hacer?`;
    
    botones = [
      { id: 'pedir', title: 'Hacer pedido' },
      { id: 'contactar', title: 'Contactar' }
    ];

  // Usuario con pedidos activos
  } else if (pedidosActivos.length > 0) {
    mensaje = `${saludo}! Tienes ${pedidosActivos.length} pedido(s) activo(s):\n\n`;
    pedidosActivos.slice(0, 2).forEach(p => {
      mensaje += `• *${p.id}* - ${p.estado}\n`;
    });
    mensaje += `\n¿Qué deseas hacer?`;

    botones = [
      { id: 'ver_pedidos', title: 'Ver pedidos' },
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'contactar', title: 'Contactar' }
    ];

  // Usuario registrado sin pedidos activos
  } else {
    const nombreCliente = cliente?.nombre?.split(' ')[0] || cliente?.empresa || '';
    mensaje = `${saludo}${nombreCliente ? ` ${nombreCliente}` : ''}! 👋\n\n` +
      `Bienvenido de vuelta a *${negocio.nombre}*\n\n¿Qué deseas hacer?`;

    botones = [
      { id: 'pedir', title: 'Nuevo pedido' },
      { id: 'ver_pedidos', title: 'Mis pedidos' },
      { id: 'contactar', title: 'Contactar' }
    ];
  }

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

async function manejarMenu(from, text, interactiveData, context, cfg) {
  const { asesorService, whatsapp, hasFeature } = context;
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  // Nuevo pedido / Ver catálogo
  if (opcion.includes('pedir') || opcion === 'pedir' || opcion.includes('catalogo')) {
    return await mostrarCatalogo(from, context, cfg);
  }

  // Ver pedidos
  if (opcion.includes('pedido') || opcion === 'ver_pedidos') {
    return await mostrarPedidosActivos(from, context, cfg);
  }

  // Enviar voucher
  if (opcion === 'enviar_voucher') {
    const { whatsapp, stateManager, negocio } = context;
    await whatsapp.sendMessage(from, 'Envía una *foto* de tu comprobante de pago.');
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  // Contactar
  if (opcion.includes('contactar') || opcion === 'contactar') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      const { negocio } = context;
      await whatsapp.sendMessage(from, 
        `*${negocio.nombre}*\n\n` +
        `Escribe tu consulta y te responderemos pronto.\n\n` +
        `_Escribe "menu" para volver_`
      );
      return;
    }
  }

  // Opción no reconocida - mostrar menú
  return await mostrarMenuPrincipal(from, context, cfg);
}

// ============================================
// CATÁLOGO
// ============================================

async function mostrarCatalogo(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  let productos = [];
  try {
    productos = await sheets.getProductos('ACTIVO');
    if (productos.length === 0) {
      productos = await sheets.getProductos('PUBLICADO');
    }
  } catch (e) {}
  
  if (!productos || productos.length === 0) {
    await whatsapp.sendMessage(from, 'No hay productos disponibles en este momento.');
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  let mensaje = `📦 *CATÁLOGO ${negocio.nombre.toUpperCase()}*\n\n`;

  productos.forEach((p, i) => {
    mensaje += `*${i + 1}.* ${p.nombre}\n`;
    mensaje += `   S/${p.precio}${cfg.unidad === 'kg' ? '/kg' : ''}\n`;
    if (p.descripcion) mensaje += `   _${p.descripcion}_\n`;
    mensaje += '\n';
  });

  if (cfg.minimoCompra > 1) {
    mensaje += `📦 Pedido mínimo: ${cfg.minimoCompra}${cfg.unidad === 'kg' ? 'kg' : ' unidades'}\n\n`;
  }

  mensaje += `Escribe el *número* del producto que deseas:`;

  await whatsapp.sendMessage(from, mensaje);

  stateManager.setState(from, negocio.id, {
    step: 'seleccion_producto',
    data: { productos }
  });
}

async function manejarSeleccionProducto(from, text, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productos } = state.data || {};

  if (!productos) {
    return await mostrarCatalogo(from, context, cfg);
  }

  const numero = parseInt(text);

  if (isNaN(numero) || numero < 1 || numero > productos.length) {
    await whatsapp.sendMessage(from, `Por favor, ingresa un número del 1 al ${productos.length}.`);
    return;
  }

  const producto = productos[numero - 1];

  // Mostrar producto con foto si está disponible
  let mensaje = `✅ Has seleccionado:\n\n*${producto.nombre}*\n`;
  if (producto.descripcion) mensaje += `${producto.descripcion}\n`;
  mensaje += `\nPrecio: S/${producto.precio}${cfg.unidad === 'kg' ? '/kg' : ''}\n\n`;
  mensaje += `*¿Cuánto${cfg.unidad === 'kg' ? 's kilos' : 'as unidades'} necesitas?*`;
  
  if (cfg.minimoCompra > 1) {
    mensaje += `\n_Pedido mínimo: ${cfg.minimoCompra}${cfg.unidad === 'kg' ? 'kg' : ' unidades'}_`;
  }

  // Enviar foto si está disponible y configurado
  const imagenUrl = producto.imagenUrl || producto.imagen || producto.ImagenURL;
  if (cfg.mostrarFotos && imagenUrl) {
    try {
      const urlFinal = convertirUrlGoogleDrive(imagenUrl);
      await whatsapp.sendImage(from, urlFinal, mensaje);
    } catch (error) {
      console.log('⚠️ Error enviando imagen:', error.message);
      await whatsapp.sendMessage(from, mensaje);
    }
  } else {
    await whatsapp.sendMessage(from, mensaje);
  }

  stateManager.updateData(from, negocio.id, { 
    productoSeleccionado: producto,
    precioFinal: producto.precio
  });
  stateManager.setStep(from, negocio.id, 'cantidad');
}

async function manejarCantidad(from, text, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, precioFinal } = state.data || {};

  if (!productoSeleccionado) {
    return await mostrarCatalogo(from, context, cfg);
  }

  const cantidad = parseFloat(text);
  const minimo = cfg.minimoCompra;

  if (isNaN(cantidad) || cantidad < minimo) {
    const unidadTexto = cfg.unidad === 'kg' ? 'kg' : 'unidad(es)';
    await whatsapp.sendMessage(from, `El pedido mínimo es de *${minimo} ${unidadTexto}*. Por favor, ingresa una cantidad mayor.`);
    return;
  }

  const total = cantidad * precioFinal;

  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');
  
  const mensaje = `*RESUMEN DE PEDIDO*\n\n` +
    `📦 ${productoSeleccionado.nombre}\n` +
    `   Cantidad: *${cantidad} ${unidadTexto}*\n` +
    `   Precio: S/${precioFinal}${cfg.unidad === 'kg' ? '/kg' : ' c/u'}\n\n` +
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

async function manejarConfirmacion(from, text, interactiveData, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado.');
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  if (!opcion.includes('sí') && !opcion.includes('si') && opcion !== 'confirmar_si') {
    await whatsapp.sendMessage(from, 'Usa los botones para confirmar o cancelar.');
    return;
  }

  // Verificar si ya tenemos datos del cliente
  let cliente = null;
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}

  if (cliente?.nombre && cliente?.direccion) {
    return await crearPedido(from, context, cliente, cfg);
  }

  // Pedir datos
  await whatsapp.sendMessage(from,
    `*DATOS DE ENVÍO*\n\n` +
    `Necesito algunos datos.\n\n` +
    `¿Cuál es tu *nombre completo* (o nombre de tu negocio)?`
  );
  stateManager.setStep(from, negocio.id, 'datos_nombre');
}

async function manejarDatosNombre(from, text, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  
  if (!text || text.length < 3) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa tu nombre completo.');
    return;
  }

  stateManager.updateData(from, negocio.id, { nombre: text, empresa: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Nombre: *${text}*\n\n` +
    `Ahora ingresa tu *dirección completa*:\n` +
    `_Incluye distrito y referencia_`
  );
  stateManager.setStep(from, negocio.id, 'datos_direccion');
}

async function manejarDatosDireccion(from, text, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  
  if (!text || text.length < 10) {
    await whatsapp.sendMessage(from, 'Por favor, ingresa una dirección más completa (incluye distrito).');
    return;
  }

  stateManager.updateData(from, negocio.id, { direccion: text });
  
  await whatsapp.sendMessage(from, 
    `✅ Dirección: *${text}*\n\n` +
    `Por último, ingresa un *número de teléfono* para coordinar:`
  );
  stateManager.setStep(from, negocio.id, 'datos_telefono');
}

async function manejarDatosTelefono(from, text, context, cfg) {
  const { sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const telefono = text.replace(/[^0-9]/g, '');

  if (telefono.length < 9) {
    const { whatsapp } = context;
    await whatsapp.sendMessage(from, 'Por favor, ingresa un teléfono válido (9 dígitos).');
    return;
  }

  const datosCliente = {
    whatsapp: from,
    nombre: state.data.nombre,
    empresa: state.data.empresa,
    telefono: telefono,
    direccion: state.data.direccion
  };

  try {
    await sheets.upsertCliente(datosCliente);
  } catch (e) {}

  return await crearPedido(from, context, datosCliente, cfg);
}

// ============================================
// CREAR PEDIDO
// ============================================

async function crearPedido(from, context, cliente, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const { productoSeleccionado, cantidad, total, precioFinal } = state.data || {};

  if (!productoSeleccionado) {
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  const pedidoId = generateId(cfg.prefijoPedido);
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // Estado inicial según flujo de pago
  const estadoInicial = cfg.flujoPago === 'contacto' 
    ? 'En preparación' 
    : config.orderStates?.PENDING_PAYMENT || 'PENDIENTE_PAGO';

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
      estado: estadoInicial
    });
  } catch (e) {
    console.error('❌ Error creando pedido:', e.message);
  }

  // Mensaje según flujo de pago
  if (cfg.flujoPago === 'contacto') {
    // Flujo B2B - contactar después
    const mensaje = `✅ *¡Pedido recibido!*\n\n` +
      `📦 *${productoSeleccionado.nombre}*\n` +
      `${cantidad} ${unidadTexto} - S/${total.toFixed(2)}\n\n` +
      `Tu código de pedido es *${pedidoId}*\n\n` +
      `Será entregado en:\n*${cliente.direccion}*\n\n` +
      `En las próximas horas te contactaremos para coordinar el pago.\n\n` +
      `¡Gracias por tu confianza! 🙌`;

    await whatsapp.sendMessage(from, mensaje);
    stateManager.resetState(from, negocio.id);

  } else {
    // Flujo voucher - mostrar métodos de pago
    const metodosPago = await sheets.getMetodosPago();
    
    let mensajePago = `✅ *PEDIDO REGISTRADO*\n\n`;
    mensajePago += `Código: *${pedidoId}*\n`;
    mensajePago += `${productoSeleccionado.nombre} x${cantidad} ${unidadTexto}\n`;
    mensajePago += `Total: *S/${total.toFixed(2)}*\n\n`;
    mensajePago += `━━━━━━━━━━━━━━━━━\n`;
    mensajePago += `*MÉTODOS DE PAGO:*\n\n`;

    if (metodosPago.length > 0) {
      metodosPago.forEach(m => {
        if (m.tipo === 'yape' || m.tipo === 'plin') {
          mensajePago += `*${m.tipo.toUpperCase()}*: ${m.numero}\n`;
        } else {
          mensajePago += `*${m.tipo.toUpperCase()}*\n`;
          mensajePago += `Cuenta: ${m.cuenta}\n`;
          if (m.cci) mensajePago += `CCI: ${m.cci}\n`;
        }
        if (m.titular) mensajePago += `Titular: ${m.titular}\n`;
        mensajePago += '\n';
      });
    } else {
      mensajePago += `Yape/Plin: (consultar)\n\n`;
    }

    mensajePago += `━━━━━━━━━━━━━━━━━\n\n`;
    mensajePago += `*Envía foto del comprobante* para confirmar.`;

    await whatsapp.sendMessage(from, mensajePago);
    stateManager.updateData(from, negocio.id, { pedidoId });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
  }
}

// ============================================
// VOUCHER
// ============================================

async function manejarVoucher(from, message, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  if (message.type !== 'image') {
    await whatsapp.sendMessage(from, 'Por favor, envía una *foto* del comprobante.');
    return;
  }

  const state = stateManager.getState(from, negocio.id);
  let pedidoId = state.data?.pedidoId;

  // Buscar pedido pendiente si no tenemos ID
  if (!pedidoId) {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    const pendiente = pedidos.find(p => 
      p.estado === 'PENDIENTE_PAGO' || p.estado === config.orderStates?.PENDING_PAYMENT
    );
    if (pendiente) {
      pedidoId = pendiente.id;
    }
  }

  if (!pedidoId) {
    await whatsapp.sendMessage(from, 
      'No tienes un pedido pendiente de pago.\n\n¿Quieres hacer uno nuevo?'
    );
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  // Actualizar estado
  const nuevoEstado = config.orderStates?.PENDING_VALIDATION || 'PENDIENTE_VALIDACION';
  await sheets.updateEstadoPedido(pedidoId, nuevoEstado);

  await whatsapp.sendMessage(from,
    `✅ *COMPROBANTE RECIBIDO*\n\n` +
    `Pedido *${pedidoId}* en validación.\n\n` +
    `Te avisamos cuando esté confirmado.\n\n` +
    `¡Gracias! 🙌`
  );

  stateManager.resetState(from, negocio.id);
}

// ============================================
// VER PEDIDOS
// ============================================

async function mostrarPedidosActivos(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  let pedidos = [];
  try {
    pedidos = await sheets.getPedidosByWhatsapp(from);
  } catch (e) {}

  const activos = (pedidos || []).filter(p => 
    !['ENTREGADO', 'CANCELADO', 'Completado'].includes(p.estado)
  );

  if (activos.length === 0) {
    await whatsapp.sendButtonMessage(from,
      'No tienes pedidos activos.\n\n¿Te gustaría hacer uno?',
      [
        { id: 'pedir', title: 'Ver catálogo' },
        { id: 'contactar', title: 'Contactar' }
      ]
    );
    stateManager.setStep(from, negocio.id, 'menu');
    return;
  }

  let mensaje = `*📋 TUS PEDIDOS ACTIVOS*\n\n`;
  
  activos.forEach(p => {
    mensaje += `*${p.id}*\n`;
    mensaje += `   Estado: ${p.estado}\n`;
    mensaje += `   Total: S/${p.total}\n\n`;
  });

  // Botones según estado de pedidos
  let botones = [];
  const pendientesPago = activos.filter(p => 
    p.estado === 'PENDIENTE_PAGO' || p.estado === config.orderStates?.PENDING_PAYMENT
  );

  if (pendientesPago.length > 0 && cfg.flujoPago === 'voucher') {
    botones.push({ id: 'enviar_voucher', title: 'Enviar voucher' });
  }
  botones.push({ id: 'pedir', title: 'Nuevo pedido' });
  botones.push({ id: 'contactar', title: 'Ayuda' });

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

// ============================================
// MUESTRAS GRATIS (Feature)
// ============================================

async function procesarMuestraGratis(from, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;

  await whatsapp.sendMessage(from,
    `🎁 *¡MUESTRA GRATIS!*\n\n` +
    `Gracias por tu interés.\n\n` +
    `Para solicitar tu muestra, necesitamos algunos datos.\n\n` +
    `¿Cuál es el *nombre de tu negocio*?`
  );

  stateManager.setState(from, negocio.id, {
    step: 'muestra_empresa',
    data: { tipo: 'MUESTRA' }
  });
}

async function continuarFlujoMuestra(from, text, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  switch (state.step) {
    case 'muestra_empresa':
      stateManager.updateData(from, negocio.id, { empresa: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *nombre completo*?');
      stateManager.setStep(from, negocio.id, 'muestra_nombre');
      break;

    case 'muestra_nombre':
      stateManager.updateData(from, negocio.id, { nombre: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *dirección completa* para el envío?\n_Incluye distrito_');
      stateManager.setStep(from, negocio.id, 'muestra_direccion');
      break;

    case 'muestra_direccion':
      stateManager.updateData(from, negocio.id, { direccion: text });
      await whatsapp.sendMessage(from, '¿Cuál es tu *número de teléfono*?');
      stateManager.setStep(from, negocio.id, 'muestra_telefono');
      break;

    case 'muestra_telefono':
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
          productos: 'Muestra gratis',
          total: 0,
          estado: 'Pendiente envío',
          observaciones: 'MUESTRA GRATIS'
        });
      } catch (e) {}

      await whatsapp.sendMessage(from,
        `✅ *¡MUESTRA SOLICITADA!*\n\n` +
        `Tu código es *${pedidoId}*\n\n` +
        `Enviaremos tu muestra a:\n*${data.direccion}*\n\n` +
        `Te contactaremos para coordinar la entrega.\n\n` +
        `¡Gracias por tu interés! 🙌`
      );

      stateManager.resetState(from, negocio.id);
      break;
  }
}

// ============================================
// UTILIDADES
// ============================================

function convertirUrlGoogleDrive(url) {
  if (!url) return url;
  
  if (url.includes('drive.google.com/thumbnail')) {
    const idMatch = url.match(/id=([^&]+)/);
    if (idMatch) {
      return `https://drive.google.com/uc?export=view&id=${idMatch[1]}`;
    }
  }
  
  if (url.includes('/file/d/')) {
    const idMatch = url.match(/\/file\/d\/([^/]+)/);
    if (idMatch) {
      return `https://drive.google.com/uc?export=view&id=${idMatch[1]}`;
    }
  }
  
  return url;
}

module.exports = { handle };
