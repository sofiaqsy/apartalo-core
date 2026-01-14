/**
 * APARTALO CORE - Handler Unificado v3.2
 * 
 * Handler conversacional con IA para toma de pedidos natural.
 * 
 * CARACTERISTICAS:
 * - Flujo conversacional con IA (no menus rigidos)
 * - Precios personalizados por cliente (PreciosClientes)
 * - Reutiliza datos del cliente registrado (direccion, telefono)
 * - Formato de productos compatible con apartalo-app
 * - Estados unificados con config.orderStates
 * - Recepcion de comprobantes de pago (vouchers) en cualquier estado
 */

const { formatPrice, getGreeting, generateId } = require('../../core/utils/formatters');
const aiOrderService = require('../../core/services/ai-order-service');
const DriveService = require('../../core/services/drive-service');
const config = require('../../config');

// Instancia del servicio de Drive para subir vouchers
const driveService = new DriveService();

/**
 * Manejar mensaje entrante
 */
async function handle(from, message, context) {
  const { whatsapp, sheets, stateManager, negocio, hasFeature, asesorService } = context;
  const { text, type, interactiveData, mediaId } = message;

  const state = stateManager.getState(from, negocio.id);
  const mensajeLimpio = (text || '').trim();
  const mensajeNormalizado = mensajeLimpio.toLowerCase();

  // Configuracion del negocio
  const cfg = {
    unidad: negocio.configExtra?.unidad || 'unidad',
    minimoCompra: negocio.configExtra?.minimoCompra || 1,
    flujoPago: negocio.configExtra?.flujoPago || 'voucher',
    mostrarFotos: negocio.configExtra?.mostrarFotos !== false,
    prefijoPedido: negocio.configExtra?.prefijoPedido || 'PED',
    usarIA: negocio.configExtra?.usarIA !== false
  };

  console.log('\n------------------------------------');
  console.log('HANDLER UNIFICADO - ' + negocio.nombre);
  console.log('   From: ' + from);
  console.log('   Mensaje: "' + mensajeLimpio + '"');
  console.log('   Tipo: ' + type);
  console.log('   Estado: ' + state.step);
  console.log('------------------------------------\n');

  // ============================================
  // DETECTAR IMAGEN - POSIBLE VOUCHER
  // ============================================
  if (type === 'image' && mediaId) {
    return await manejarImagenRecibida(from, mediaId, mensajeLimpio, context, cfg);
  }

  // ============================================
  // COMANDOS GLOBALES
  // ============================================
  if (mensajeNormalizado === 'menu' || mensajeNormalizado === 'inicio') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  if (mensajeNormalizado === 'cancelar') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Operacion cancelada.');
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  // ============================================
  // TRIGGERS ESPECIALES (por features)
  // ============================================
  
  // Muestras gratis
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
      mensajeNormalizado === 'ayuda' ||
      mensajeNormalizado === 'hablar con alguien') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      await whatsapp.sendMessage(from, 
        negocio.nombre + '\n\n' +
        'Escribe tu consulta y te responderemos pronto.\n\n' +
        'Escribe "menu" para volver.'
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

    case 'pedido_conversacional':
      return await continuarPedidoConversacional(from, mensajeLimpio, context, cfg);

    case 'confirmar_pedido':
      return await manejarConfirmacion(from, text, interactiveData, context, cfg);

    case 'esperando_voucher':
      return await manejarVoucher(from, message, context, cfg);

    case 'seleccionar_pedido_voucher':
      return await manejarSeleccionPedidoVoucher(from, text, interactiveData, context, cfg);

    default:
      return await mostrarMenuPrincipal(from, context, cfg);
  }
}

// ============================================
// MANEJO DE IMAGENES / VOUCHERS
// ============================================

/**
 * Manejar imagen recibida - detectar si es voucher
 */
async function manejarImagenRecibida(from, mediaId, caption, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio, firebaseService } = context;

  console.log('Imagen recibida de ' + from);

  // Buscar pedidos activos del cliente (cualquier estado excepto ENTREGADO/CANCELADO)
  let pedidosActivos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = pedidos.filter(p => 
      !['ENTREGADO', 'CANCELADO'].includes(p.estado)
    );
  } catch (e) {
    console.log('Error buscando pedidos:', e.message);
  }

  // Si no hay pedido activo, preguntar
  if (pedidosActivos.length === 0) {
    await whatsapp.sendButtonMessage(from,
      'Recibi tu imagen.\n\nSi es un comprobante de pago, primero necesitas tener un pedido activo.',
      [
        { id: 'pedir', title: 'Hacer pedido' },
        { id: 'contactar', title: 'Hablar con asesor' }
      ]
    );
    stateManager.setStep(from, negocio.id, 'menu');
    return;
  }

  // Si hay un solo pedido activo, asociar directamente
  // Si hay varios, usar el mas reciente
  const pedidoActivo = pedidosActivos[0];

  // Procesar como voucher
  try {
    // Descargar imagen de WhatsApp
    const mediaData = await whatsapp.downloadMedia(mediaId);
    
    // Subir a Google Drive
    const fileName = `voucher_${pedidoActivo.id}_${Date.now()}.jpg`;
    const uploadResult = await driveService.uploadImage(
      mediaData.data,
      fileName,
      mediaData.contentType || 'image/jpeg',
      negocio.id
    );

    console.log('Voucher subido:', uploadResult.url);

    // Guardar evidencia en el pedido
    await guardarEvidenciaPedido(sheets, pedidoActivo.id, {
      url: uploadResult.url,
      tipo: 'WHATSAPP',
      fecha: new Date().toISOString(),
      descripcion: caption || 'Comprobante enviado por WhatsApp'
    });

    // Notificar al negocio
    if (firebaseService) {
      await firebaseService.notificarVoucherRecibido(negocio.id, pedidoActivo);
    }

    // Confirmar al cliente
    await whatsapp.sendMessage(from,
      'COMPROBANTE RECIBIDO\n\n' +
      'Pedido: ' + pedidoActivo.id + '\n' +
      'Estado: ' + pedidoActivo.estado + '\n' +
      'Total: S/' + (pedidoActivo.total || 0).toFixed(2) + '\n\n' +
      'Tu comprobante ha sido guardado.\n\n' +
      'Gracias.'
    );

    stateManager.resetState(from, negocio.id);

  } catch (error) {
    console.error('Error procesando voucher:', error.message);
    
    await whatsapp.sendMessage(from,
      'Hubo un problema guardando tu comprobante.\n\n' +
      'Por favor intenta enviarlo de nuevo o escribe "ayuda" para contactar con soporte.'
    );
  }
}

/**
 * Guardar evidencia de pago en el pedido (usando la columna K de Sheets)
 */
async function guardarEvidenciaPedido(sheets, pedidoId, evidencia) {
  try {
    const rows = await sheets.getRows('Pedidos!A:K');
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === pedidoId) {
        // Obtener evidencias actuales
        let evidencias = [];
        const voucherUrlsRaw = rows[i][10] || '';
        
        if (voucherUrlsRaw) {
          try {
            evidencias = JSON.parse(voucherUrlsRaw);
            if (!Array.isArray(evidencias)) evidencias = [];
          } catch (e) {
            // Formato antiguo: convertir URL a evidencia
            if (voucherUrlsRaw.startsWith('http')) {
              evidencias = [{
                id: 'ev_legacy',
                url: voucherUrlsRaw,
                tipo: 'WHATSAPP',
                fecha: new Date().toISOString(),
                descripcion: 'Comprobante migrado'
              }];
            }
          }
        }
        
        // Agregar nueva evidencia
        evidencias.push({
          id: `ev_${Date.now()}`,
          ...evidencia
        });
        
        // Guardar en Sheets
        await sheets.updateCell(`Pedidos!K${i + 1}`, JSON.stringify(evidencias));
        console.log('Evidencia guardada en pedido ' + pedidoId);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Error guardando evidencia:', error.message);
    return false;
  }
}

// ============================================
// UTILIDAD: Merge inteligente (no sobrescribe con null)
// ============================================
function mergeDatasSinNull(acumulado, nuevo) {
  if (!nuevo) return acumulado;
  
  const resultado = { ...acumulado };
  
  for (const key in nuevo) {
    if (nuevo[key] !== null && nuevo[key] !== undefined && nuevo[key] !== '') {
      resultado[key] = nuevo[key];
    }
  }
  
  return resultado;
}

// ============================================
// UTILIDAD: Formatear productos para Sheets
// Formato: "6x Cafe 250g - S/90.00" (legible y parseable)
// ============================================
function formatearProductosParaSheets(productos) {
  if (!Array.isArray(productos)) {
    productos = [productos];
  }
  
  return productos.map(p => {
    const cantidad = p.cantidad || 1;
    const nombre = p.nombre || 'Producto';
    const subtotal = (p.precio || 0) * cantidad;
    return cantidad + 'x ' + nombre + ' - S/' + subtotal.toFixed(2);
  }).join(', ');
}

// ============================================
// UTILIDAD: Extraer nombre de producto de cualquier formato
// Soporta JSON y texto plano
// ============================================
function extraerNombreProducto(productosStr) {
  if (!productosStr) return 'Pedido';
  
  try {
    // Intentar parsear como JSON
    if (productosStr.startsWith('[') || productosStr.startsWith('{')) {
      const productos = JSON.parse(productosStr);
      if (Array.isArray(productos) && productos.length > 0) {
        const p = productos[0];
        const nombre = p.nombre || p.name || 'Producto';
        const cantidad = p.cantidad || p.qty || 1;
        return nombre + ' x' + cantidad;
      }
    }
    
    // Si es texto plano tipo "3x Cafe - S/45.00"
    const match = productosStr.match(/^(\d+)x\s+(.+?)\s+-/);
    if (match) {
      return match[2] + ' x' + match[1];
    }
    
    return productosStr.substring(0, 30);
  } catch (e) {
    return productosStr.substring(0, 30) || 'Pedido';
  }
}

// ============================================
// MENU PRINCIPAL
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
      !['ENTREGADO', 'CANCELADO'].includes(p.estado)
    );
  } catch (e) {}

  const saludo = getGreeting();
  let mensaje = '';
  let botones = [];

  if (!cliente && pedidosActivos.length === 0) {
    mensaje = saludo + '\n\nBienvenido a ' + negocio.nombre + '\n\nQue deseas hacer?';
    
    botones = [
      { id: 'pedir', title: 'Hacer pedido' },
      { id: 'contactar', title: 'Contactar' }
    ];

  } else if (pedidosActivos.length > 0) {
    mensaje = saludo + ' Tienes ' + pedidosActivos.length + ' pedido(s) activo(s):\n\n';
    
    pedidosActivos.slice(0, 2).forEach(p => {
      const nombreProd = extraerNombreProducto(p.productos);
      mensaje += '- ' + nombreProd + '\n';
      mensaje += '  Estado: ' + p.estado + '\n\n';
    });
    
    mensaje += 'Que deseas hacer?';

    // Siempre mostrar opcion de enviar voucher si hay pedidos activos
    botones = [
      { id: 'enviar_voucher', title: 'Enviar comprobante' },
      { id: 'ver_pedidos', title: 'Ver pedidos' },
      { id: 'pedir', title: 'Nuevo pedido' }
    ];

  } else {
    const nombreCliente = cliente?.nombre?.split(' ')[0] || cliente?.empresa || '';
    mensaje = saludo + (nombreCliente ? ' ' + nombreCliente : '') + '\n\n' +
      'Bienvenido de vuelta a ' + negocio.nombre + '\n\nQue deseas hacer?';

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
  const { asesorService, whatsapp, hasFeature, stateManager, negocio, sheets } = context;
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('pedir') || opcion === 'pedir' || opcion.includes('catalogo')) {
    return await iniciarPedidoConversacional(from, context, cfg);
  }

  if (opcion.includes('pedido') || opcion === 'ver_pedidos') {
    return await mostrarPedidosActivos(from, context, cfg);
  }

  if (opcion === 'enviar_voucher' || opcion === 'enviar_comprobante') {
    return await iniciarEnvioVoucher(from, context, cfg);
  }

  if (opcion.includes('contactar') || opcion === 'contactar') {
    if (hasFeature('asesorHumano') && asesorService) {
      const resultado = await asesorService.activarModoAsesor(from, context);
      await whatsapp.sendMessage(from, resultado.mensaje);
      return;
    } else {
      await whatsapp.sendMessage(from, 
        negocio.nombre + '\n\n' +
        'Escribe tu consulta y te responderemos pronto.\n\n' +
        'Escribe "menu" para volver.'
      );
      return;
    }
  }

  return await mostrarMenuPrincipal(from, context, cfg);
}

// ============================================
// FLUJO ENVIAR VOUCHER
// ============================================

async function iniciarEnvioVoucher(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  // Buscar pedidos activos (cualquier estado excepto ENTREGADO/CANCELADO)
  let pedidosActivos = [];
  try {
    const pedidos = await sheets.getPedidosByWhatsapp(from);
    pedidosActivos = pedidos.filter(p => 
      !['ENTREGADO', 'CANCELADO'].includes(p.estado)
    );
  } catch (e) {}

  if (pedidosActivos.length === 0) {
    await whatsapp.sendMessage(from, 
      'No tienes pedidos activos.\n\n' +
      'Escribe "menu" para ver opciones.'
    );
    stateManager.setStep(from, negocio.id, 'menu');
    return;
  }

  // Si hay un solo pedido, ir directo
  if (pedidosActivos.length === 1) {
    const pedido = pedidosActivos[0];
    await whatsapp.sendMessage(from, 
      'ENVIAR COMPROBANTE DE PAGO\n\n' +
      'Pedido: ' + pedido.id + '\n' +
      'Estado: ' + pedido.estado + '\n' +
      'Total: S/' + (pedido.total || 0).toFixed(2) + '\n\n' +
      'Envia una foto de tu voucher, captura de Yape/Plin o comprobante de transferencia.'
    );
    stateManager.updateData(from, negocio.id, { pedidoSeleccionado: pedido.id });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  // Si hay varios pedidos, mostrar lista para seleccionar
  let mensaje = 'SELECCIONA EL PEDIDO\n\n';
  mensaje += 'Tienes ' + pedidosActivos.length + ' pedidos activos:\n\n';
  
  pedidosActivos.forEach((p, idx) => {
    const nombreProd = extraerNombreProducto(p.productos);
    mensaje += (idx + 1) + '. ' + p.id + '\n';
    mensaje += '   ' + nombreProd + '\n';
    mensaje += '   Estado: ' + p.estado + '\n';
    mensaje += '   Total: S/' + (p.total || 0).toFixed(2) + '\n\n';
  });
  
  mensaje += 'Responde con el numero del pedido (1, 2, etc.)';

  await whatsapp.sendMessage(from, mensaje);
  stateManager.updateData(from, negocio.id, { pedidosActivos });
  stateManager.setStep(from, negocio.id, 'seleccionar_pedido_voucher');
}

async function manejarSeleccionPedidoVoucher(from, text, interactiveData, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const pedidosActivos = state.data?.pedidosActivos || [];

  const textoLower = (text || '').toLowerCase().trim();
  
  // Verificar si quiere salir
  if (textoLower === 'menu' || textoLower === 'cancelar') {
    stateManager.resetState(from, negocio.id);
    return await mostrarMenuPrincipal(from, context, cfg);
  }

  // Intentar parsear numero
  const numero = parseInt(text);
  
  if (isNaN(numero) || numero < 1 || numero > pedidosActivos.length) {
    await whatsapp.sendMessage(from, 
      'Por favor responde con un numero valido (1 a ' + pedidosActivos.length + ').\n\n' +
      'Escribe "menu" para volver al inicio.'
    );
    return;
  }

  const pedidoSeleccionado = pedidosActivos[numero - 1];
  
  await whatsapp.sendMessage(from, 
    'ENVIAR COMPROBANTE DE PAGO\n\n' +
    'Pedido: ' + pedidoSeleccionado.id + '\n' +
    'Estado: ' + pedidoSeleccionado.estado + '\n' +
    'Total: S/' + (pedidoSeleccionado.total || 0).toFixed(2) + '\n\n' +
    'Envia una foto de tu voucher, captura de Yape/Plin o comprobante de transferencia.'
  );
  
  stateManager.updateData(from, negocio.id, { pedidoSeleccionado: pedidoSeleccionado.id });
  stateManager.setStep(from, negocio.id, 'esperando_voucher');
}

// ============================================
// PEDIDO CONVERSACIONAL CON IA
// ============================================

async function iniciarPedidoConversacional(from, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  // Buscar cliente existente para reutilizar sus datos
  let cliente = null;
  try {
    cliente = await sheets.buscarCliente(from);
  } catch (e) {}

  const mensajeInicial = 'Con gusto te ayudo.\n\n' +
    'Cuentame, que producto te interesa? Puedes preguntarme por opciones disponibles o decirme directamente lo que necesitas.';

  await whatsapp.sendMessage(from, mensajeInicial);

  // Inicializar con datos del cliente si existen
  const datosIniciales = {};
  if (cliente) {
    if (cliente.nombre) datosIniciales.nombre_cliente = cliente.nombre;
    if (cliente.direccion) datosIniciales.direccion = cliente.direccion;
    if (cliente.telefono) datosIniciales.telefono = cliente.telefono;
  }

  stateManager.setState(from, negocio.id, {
    step: 'pedido_conversacional',
    data: {
      historial: [],
      datosCliente: cliente,
      datosExtraidos: datosIniciales,
      ultimoProductoMostrado: null
    }
  });
}

async function continuarPedidoConversacional(from, mensaje, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);

  const historial = state.data?.historial || [];
  const datosCliente = state.data?.datosCliente || null;
  let datosAcumulados = state.data?.datosExtraidos || {};
  const ultimoProductoMostrado = state.data?.ultimoProductoMostrado || null;

  // Llamar a IA
  const resultado = await aiOrderService.procesarMensajePedido(
    mensaje,
    context,
    historial,
    datosCliente,
    from
  );

  if (resultado.error) {
    await whatsapp.sendMessage(from, resultado.respuesta);
    return;
  }

  // Merge inteligente
  if (resultado.datosExtraidos) {
    datosAcumulados = mergeDatasSinNull(datosAcumulados, resultado.datosExtraidos);
  }

  console.log('Datos acumulados:', JSON.stringify(datosAcumulados));

  historial.push({ rol: 'cliente', texto: mensaje });
  historial.push({ rol: 'asistente', texto: resultado.respuesta });

  // Verificar si se identifico un producto nuevo
  const productoCodigoActual = datosAcumulados.producto_codigo;
  let productoParaMostrar = null;

  if (productoCodigoActual && productoCodigoActual !== ultimoProductoMostrado && cfg.mostrarFotos) {
    try {
      const productos = await sheets.getProductosConPrecios(from);
      productoParaMostrar = productos.find(p => p.codigo === productoCodigoActual);
    } catch (e) {
      console.log('Error buscando producto para imagen:', e.message);
    }
  }

  // Verificar si pedido completo
  if (resultado.pedidoCompleto && datosAcumulados.producto_codigo && datosAcumulados.cantidad) {
    stateManager.updateData(from, negocio.id, {
      historial,
      datosExtraidos: datosAcumulados,
      ultimoProductoMostrado: productoCodigoActual
    });
    
    return await confirmarPedidoIA(from, context, cfg, datosAcumulados);
  }

  // Actualizar estado
  stateManager.updateData(from, negocio.id, {
    historial,
    datosExtraidos: datosAcumulados,
    ultimoProductoMostrado: productoCodigoActual
  });

  // Enviar imagen del producto si hay una nueva identificacion
  if (productoParaMostrar && productoParaMostrar.imagenUrl) {
    try {
      await whatsapp.sendImage(from, productoParaMostrar.imagenUrl, productoParaMostrar.nombre);
    } catch (e) {
      console.log('Error enviando imagen:', e.message);
    }
  }

  // Enviar respuesta de texto
  await whatsapp.sendMessage(from, resultado.respuesta);
}

async function confirmarPedidoIA(from, context, cfg, datos) {
  const { whatsapp, sheets, stateManager, negocio } = context;

  console.log('confirmarPedidoIA - datos recibidos:', JSON.stringify(datos));

  // Obtener productos con precios personalizados
  let productos = [];
  try {
    productos = await sheets.getProductosConPrecios(from);
  } catch (e) {
    productos = await sheets.getProductos('ACTIVO');
  }

  // Buscar producto
  let producto = null;
  
  if (datos.producto_codigo) {
    producto = productos.find(p => p.codigo === datos.producto_codigo);
  }
  
  if (!producto && datos.producto_nombre) {
    producto = productos.find(p => 
      p.nombre.toLowerCase().includes(datos.producto_nombre.toLowerCase())
    );
  }

  if (!producto) {
    console.log('Producto no encontrado. Codigo:', datos.producto_codigo, 'Nombre:', datos.producto_nombre);
    
    await whatsapp.sendMessage(from, 
      'No pude identificar el producto. Podrias indicarme nuevamente cual deseas?'
    );
    return;
  }

  const cantidad = parseFloat(datos.cantidad) || cfg.minimoCompra;
  const precioUnitario = producto.precio;
  const total = cantidad * precioUnitario;
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // Guardar datos
  stateManager.updateData(from, negocio.id, {
    productoSeleccionado: producto,
    cantidad,
    total,
    precioFinal: precioUnitario,
    nombreCliente: datos.nombre_cliente,
    direccion: datos.direccion,
    telefono: datos.telefono
  });

  let mensaje = 'RESUMEN DE TU PEDIDO\n\n' +
    'Producto: ' + producto.nombre + '\n' +
    'Cantidad: ' + cantidad + ' ' + unidadTexto + '\n' +
    'Precio unitario: S/' + precioUnitario + '\n' +
    'Total: S/' + total.toFixed(2) + '\n';

  if (producto.tieneDescuento) {
    mensaje += '(Precio especial aplicado)\n';
  }

  mensaje += '\nEntrega:\n' +
    (datos.nombre_cliente ? 'Nombre: ' + datos.nombre_cliente + '\n' : '') +
    (datos.direccion ? 'Direccion: ' + datos.direccion + '\n' : '') +
    (datos.telefono ? 'Telefono: ' + datos.telefono + '\n' : '') +
    '\nConfirmas el pedido?';

  await whatsapp.sendButtonMessage(from, mensaje, [
    { id: 'confirmar_si', title: 'Si, confirmar' },
    { id: 'confirmar_no', title: 'Cancelar' }
  ]);

  stateManager.setStep(from, negocio.id, 'confirmar_pedido');
}

// ============================================
// CONFIRMACION Y CREACION DE PEDIDO
// ============================================

async function manejarConfirmacion(from, text, interactiveData, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio } = context;
  const state = stateManager.getState(from, negocio.id);
  const opcion = (interactiveData?.id || text || '').toLowerCase();

  if (opcion.includes('no') || opcion === 'confirmar_no') {
    stateManager.resetState(from, negocio.id);
    await whatsapp.sendMessage(from, 'Pedido cancelado. Escribe "menu" para volver al inicio.');
    return;
  }

  if (!opcion.includes('si') && opcion !== 'confirmar_si') {
    await whatsapp.sendMessage(from, 'Por favor usa los botones para confirmar o cancelar.');
    return;
  }

  const { productoSeleccionado, cantidad, total, precioFinal, nombreCliente, direccion, telefono } = state.data || {};

  if (!productoSeleccionado) {
    await whatsapp.sendMessage(from, 'Ocurrio un error. Escribe "menu" para comenzar de nuevo.');
    stateManager.resetState(from, negocio.id);
    return;
  }

  // Si faltan datos, pedirlos
  if (!nombreCliente || !direccion) {
    await whatsapp.sendMessage(from, 
      'Para completar el pedido, necesito algunos datos.\n\n' +
      'Por favor indicame tu nombre completo, direccion de entrega (incluye distrito) y un telefono de contacto.'
    );
    stateManager.setStep(from, negocio.id, 'pedido_conversacional');
    return;
  }

  const pedidoId = generateId(cfg.prefijoPedido);
  const unidadTexto = cfg.unidad === 'kg' ? 'kg' : (cantidad === 1 ? 'unidad' : 'unidades');

  // ESTADOS UNIFICADOS - usar config.orderStates
  const estadoInicial = cfg.flujoPago === 'contacto' 
    ? config.orderStates?.IN_PREPARATION || 'EN_PREPARACION'
    : config.orderStates?.PENDING_PAYMENT || 'PENDIENTE_PAGO';

  // Formato de productos compatible con apartalo-app
  // Formato: "6x Cafe 250g - S/90.00"
  const productosTexto = formatearProductosParaSheets([{
    codigo: productoSeleccionado.codigo,
    nombre: productoSeleccionado.nombre,
    cantidad,
    precio: precioFinal
  }]);

  try {
    // Actualizar o crear cliente con los datos del pedido
    await sheets.upsertCliente({
      whatsapp: from,
      nombre: nombreCliente,
      telefono: telefono || '',
      direccion: direccion
    });

    await sheets.crearPedido({
      id: pedidoId,
      whatsapp: from,
      cliente: nombreCliente,
      telefono: telefono || '',
      direccion: direccion,
      productos: productosTexto,  // Formato legible: "6x Cafe - S/90.00"
      total,
      estado: estadoInicial,
      observaciones: 'WhatsApp Bot'  // Identificar origen
    });
  } catch (e) {
    console.error('Error creando pedido:', e.message);
  }

  if (cfg.flujoPago === 'contacto') {
    const mensaje = 'PEDIDO CONFIRMADO\n\n' +
      'Codigo: ' + pedidoId + '\n' +
      'Producto: ' + productoSeleccionado.nombre + '\n' +
      'Cantidad: ' + cantidad + ' ' + unidadTexto + '\n' +
      'Total: S/' + total.toFixed(2) + '\n\n' +
      'Entrega en: ' + direccion + '\n\n' +
      'Te contactaremos en las proximas horas para coordinar el pago y la entrega.\n\n' +
      'Gracias por tu compra.';

    await whatsapp.sendMessage(from, mensaje);
  } else {
    const metodosPago = await sheets.getMetodosPago();
    
    let mensajePago = 'PEDIDO REGISTRADO\n\n';
    mensajePago += 'Codigo: ' + pedidoId + '\n';
    mensajePago += productoSeleccionado.nombre + ' x' + cantidad + ' ' + unidadTexto + '\n';
    mensajePago += 'Total: S/' + total.toFixed(2) + '\n\n';
    mensajePago += 'METODOS DE PAGO:\n\n';

    if (metodosPago.length > 0) {
      metodosPago.forEach(m => {
        if (m.tipo === 'yape' || m.tipo === 'plin') {
          mensajePago += m.tipo.toUpperCase() + ': ' + m.numero + '\n';
        } else {
          mensajePago += m.tipo.toUpperCase() + '\n';
          mensajePago += 'Cuenta: ' + m.cuenta + '\n';
          if (m.cci) mensajePago += 'CCI: ' + m.cci + '\n';
        }
        if (m.titular) mensajePago += 'Titular: ' + m.titular + '\n';
        mensajePago += '\n';
      });
    } else {
      mensajePago += 'Yape/Plin: (consultar)\n\n';
    }

    mensajePago += 'Envia foto del comprobante para confirmar.';

    await whatsapp.sendMessage(from, mensajePago);
    stateManager.updateData(from, negocio.id, { pedidoId });
    stateManager.setStep(from, negocio.id, 'esperando_voucher');
    return;
  }

  stateManager.resetState(from, negocio.id);
}

// ============================================
// VOUCHER (estado esperando_voucher)
// ============================================

async function manejarVoucher(from, message, context, cfg) {
  const { whatsapp, sheets, stateManager, negocio, firebaseService } = context;
  const { type, mediaId, text } = message;

  // Si escribio texto, verificar si quiere salir
  if (type === 'text') {
    const textoLower = (text || '').toLowerCase();
    if (textoLower === 'menu' || textoLower === 'cancelar') {
      stateManager.resetState(from, negocio.id);
      return await mostrarMenuPrincipal(from, context, cfg);
    }
    
    await whatsapp.sendMessage(from, 
      'Por favor, envia una foto de tu comprobante de pago.\n\n' +
      'Puede ser captura de Yape, Plin o voucher de transferencia.\n\n' +
      'Escribe "menu" para volver al menu principal.'
    );
    return;
  }

  // Si no es imagen
  if (type !== 'image' || !mediaId) {
    await whatsapp.sendMessage(from, 
      'Necesito una imagen del comprobante.\n\n' +
      'Por favor envia una foto de tu voucher, captura de Yape/Plin o comprobante de transferencia.'
    );
    return;
  }

  // Es una imagen - procesar como voucher
  return await manejarImagenRecibida(from, mediaId, text || '', context, cfg);
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
    !['ENTREGADO', 'CANCELADO'].includes(p.estado)
  );

  if (activos.length === 0) {
    await whatsapp.sendButtonMessage(from,
      'No tienes pedidos activos.\n\nTe gustaria hacer uno?',
      [
        { id: 'pedir', title: 'Hacer pedido' },
        { id: 'contactar', title: 'Contactar' }
      ]
    );
    stateManager.setStep(from, negocio.id, 'menu');
    return;
  }

  let mensaje = 'TUS PEDIDOS ACTIVOS\n\n';
  
  activos.forEach(p => {
    const nombreProd = extraerNombreProducto(p.productos);
    mensaje += nombreProd + '\n';
    mensaje += 'Codigo: ' + p.id + '\n';
    mensaje += 'Estado: ' + p.estado + '\n';
    mensaje += 'Total: S/' + p.total + '\n';
    
    if (p.direccion) {
      mensaje += 'Entrega: ' + p.direccion + '\n';
    }
    
    if (p.cliente) {
      mensaje += 'Cliente: ' + p.cliente + '\n';
    }
    
    mensaje += '\n';
  });

  // Siempre mostrar opcion de enviar comprobante si hay pedidos activos
  let botones = [
    { id: 'enviar_voucher', title: 'Enviar comprobante' },
    { id: 'pedir', title: 'Nuevo pedido' },
    { id: 'contactar', title: 'Ayuda' }
  ];

  await whatsapp.sendButtonMessage(from, mensaje, botones);
  stateManager.setStep(from, negocio.id, 'menu');
}

// ============================================
// MUESTRAS GRATIS (Feature) - 500g
// ============================================

async function procesarMuestraGratis(from, context, cfg) {
  const { whatsapp, stateManager, negocio } = context;

  await whatsapp.sendMessage(from,
    'MUESTRA GRATIS DE CAFE 500g\n\n' +
    'Gracias por tu interes en nuestro cafe.\n\n' +
    'Para solicitar tu muestra, necesitamos algunos datos.\n\n' +
    'Cual es el nombre de tu cafeteria o negocio?'
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
      await whatsapp.sendMessage(from, 'Cual es tu nombre completo?');
      stateManager.setStep(from, negocio.id, 'muestra_nombre');
      break;

    case 'muestra_nombre':
      stateManager.updateData(from, negocio.id, { nombre: text });
      await whatsapp.sendMessage(from, 'Cual es tu direccion completa para el envio? (incluye distrito)');
      stateManager.setStep(from, negocio.id, 'muestra_direccion');
      break;

    case 'muestra_direccion':
      stateManager.updateData(from, negocio.id, { direccion: text });
      await whatsapp.sendMessage(from, 'Cual es tu numero de telefono?');
      stateManager.setStep(from, negocio.id, 'muestra_telefono');
      break;

    case 'muestra_telefono':
      const data = state.data;
      data.telefono = text;

      const pedidoId = generateId('MUE');
      
      // Estado para muestras: ENVIADO ya que se procesara manualmente
      const estadoMuestra = config.orderStates?.SHIPPED || 'ENVIADO';
      
      try {
        await sheets.crearPedido({
          id: pedidoId,
          whatsapp: from,
          cliente: data.empresa,
          telefono: data.telefono,
          direccion: data.direccion,
          productos: '1x Muestra Cafe 500g - S/0.00',
          total: 0,
          estado: estadoMuestra,
          observaciones: 'MUESTRA GRATIS 500g - WhatsApp Bot'
        });
      } catch (e) {}

      await whatsapp.sendMessage(from,
        'MUESTRA SOLICITADA\n\n' +
        'Tu codigo es ' + pedidoId + '\n\n' +
        'Enviaremos tu muestra de 500g a:\n' + data.direccion + '\n\n' +
        'Te contactaremos para coordinar la entrega.\n\n' +
        'Gracias por tu interes en Finca Rosal.'
      );

      stateManager.resetState(from, negocio.id);
      break;
  }
}

module.exports = { handle };
