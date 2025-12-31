/**
 * APARTALO CORE - Servicio de IA Mejorado v2
 * 
 * IA contextual que entiende intenciones reales del cliente
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

class AIService {
  constructor() {
    this.provider = null;
    this.initialized = false;
  }

  async initialize() {
    console.log('🤖 AI Service inicializando...');
    console.log(`   GROQ_API_KEY: ${GROQ_API_KEY ? 'SET (' + GROQ_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}`);
    console.log(`   GEMINI_API_KEY: ${GEMINI_API_KEY ? 'SET (' + GEMINI_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}`);
    
    if (GROQ_API_KEY) {
      this.provider = 'groq';
      this.initialized = true;
      console.log('🤖 IA: Groq configurado');
      return true;
    }
    
    if (GEMINI_API_KEY) {
      this.provider = 'gemini';
      this.initialized = true;
      console.log('🤖 IA: Gemini configurado');
      return true;
    }

    console.log('⚠️ IA: Sin API keys - usando respuestas locales');
    return false;
  }

  /**
   * Procesar mensaje con contexto completo
   */
  async procesarMensaje(mensaje, contexto = {}) {
    const { tipoMensaje = 'text' } = contexto;
    
    console.log(`🤖 AI procesarMensaje: "${mensaje}" (tipo: ${tipoMensaje})`);
    
    // Manejar tipos especiales de mensaje (media)
    if (tipoMensaje === 'image') {
      return this.manejarImagen(mensaje, contexto);
    }
    
    if (tipoMensaje === 'location') {
      return this.manejarUbicacion(mensaje, contexto);
    }
    
    if (tipoMensaje === 'document') {
      return this.manejarDocumento(mensaje, contexto);
    }
    
    if (tipoMensaje === 'audio' || tipoMensaje === 'voice') {
      return this.manejarAudio(mensaje, contexto);
    }

    // Mensaje de texto - usar IA o respuesta local
    if (!this.initialized) {
      return this.respuestaLocal(mensaje, contexto);
    }

    try {
      const prompt = this.construirPromptInteligente(mensaje, contexto);
      
      let resultado;
      if (this.provider === 'groq') {
        resultado = await this.llamarGroq(prompt);
      } else {
        resultado = await this.llamarGemini(prompt);
      }

      if (resultado) {
        console.log(`   → IA resultado: ${resultado.accion}`);
        return resultado;
      }
    } catch (error) {
      console.error('❌ Error IA:', error.message);
    }

    return this.respuestaLocal(mensaje, contexto);
  }

  /**
   * Manejar imagen recibida
   */
  manejarImagen(caption, contexto) {
    const { estadoActual = 'inicio' } = contexto;
    console.log(`   📷 Imagen recibida en estado: ${estadoActual}`);

    if (estadoActual === 'esperando_voucher') {
      return {
        respuesta: null,
        accion: 'procesar_voucher',
        datos: {}
      };
    }

    if (caption) {
      return {
        respuesta: `Recibí tu imagen 📷\n\n"${caption}"\n\n¿Es un comprobante de pago o me quieres mostrar algo?`,
        accion: 'continuar',
        datos: { tieneImagen: true, caption }
      };
    }

    return {
      respuesta: '¡Recibí tu imagen! 📷\n\n¿Es un comprobante de pago?',
      accion: 'preguntar_imagen',
      datos: { tieneImagen: true }
    };
  }

  manejarUbicacion(mensaje, contexto) {
    const { estadoActual = 'inicio' } = contexto;

    if (estadoActual === 'datos_direccion' || estadoActual === 'datos_ciudad') {
      return {
        respuesta: '¡Perfecto! Recibí tu ubicación 📍\n\n¿Puedes confirmarme la dirección exacta?',
        accion: 'guardar_ubicacion',
        datos: { tieneUbicacion: true }
      };
    }

    return {
      respuesta: '¡Gracias por tu ubicación! 📍 La tendré en cuenta para el envío.',
      accion: 'continuar',
      datos: { tieneUbicacion: true }
    };
  }

  manejarDocumento(mensaje, contexto) {
    return {
      respuesta: 'Recibí tu documento 📄\n\nSi es un comprobante de pago, ¿puedes enviarlo como foto para verlo mejor?',
      accion: 'continuar',
      datos: { tieneDocumento: true }
    };
  }

  manejarAudio(mensaje, contexto) {
    return {
      respuesta: '🎤 Recibí tu audio, pero por ahora no puedo escucharlo.\n\n¿Puedes escribirme tu consulta?',
      accion: 'continuar',
      datos: { tieneAudio: true }
    };
  }

  /**
   * Construir prompt inteligente - MEJORADO
   */
  construirPromptInteligente(mensaje, contexto) {
    const { 
      negocio, 
      productos = [], 
      estadoActual = 'inicio',
      datosCliente = {},
      pedidoActual = null
    } = contexto;
    
    const productosTexto = productos.slice(0, 8).map(p => 
      `- ${p.nombre}: S/${p.precio}`
    ).join('\n');

    const contextoEstado = this.describirEstado(estadoActual, pedidoActual, datosCliente);

    return `Eres el asistente de WhatsApp de "${negocio?.nombre || 'la tienda'}".
Tu rol es ayudar al cliente de forma NATURAL y CONVERSACIONAL.

PRODUCTOS:
${productosTexto || 'Sin productos'}

CONTEXTO: ${contextoEstado}

REGLAS CRÍTICAS:
1. NO muestres el catálogo a menos que el cliente EXPLÍCITAMENTE lo pida
2. Si piden "foto" o "imagen" de un producto → NO TENEMOS fotos disponibles por WhatsApp, discúlpate amablemente
3. Si preguntan por un producto específico → Da info del producto SIN mostrar todo el catálogo
4. Si la intención no es clara → PREGUNTA qué necesitan, no asumas
5. Sé breve (2-3 líneas máximo)
6. Usa emojis con moderación

INTENCIONES A DETECTAR:
- "quiero ver foto/imagen de X" → No tenemos fotos, ofrecer descripción o visita presencial
- "quiero comprar X" → Dar info del producto y preguntar cantidad
- "cuánto cuesta X" → Solo dar precio de X
- "tienen X" → Confirmar si hay stock de X
- "ver catálogo/productos" → SOLO aquí mostrar catálogo
- pregunta general → Responder conversacionalmente

ACCIONES (JSON):
- ver_catalogo: SOLO si piden explícitamente ver todos los productos
- info_producto: Dar información de un producto específico {producto: "nombre"}
- sin_fotos: Explicar que no tenemos fotos disponibles
- preguntar: Pedir aclaración al cliente
- contactar: Conectar con humano
- continuar: Solo responder, sin acción extra
- confirmar_compra: El cliente quiere comprar algo específico {producto: "nombre"}

MENSAJE: "${mensaje}"

JSON válido:
{"respuesta": "mensaje corto", "accion": "nombre", "datos": {}}`;
  }

  describirEstado(estado, pedido, cliente) {
    const descripciones = {
      'inicio': 'Conversación nueva',
      'menu': 'Viendo menú',
      'seleccion_producto': 'Eligiendo producto del catálogo',
      'cantidad': 'Debe indicar cantidad',
      'confirmar_pedido': 'Confirmando pedido',
      'datos_nombre': 'Pidiendo nombre',
      'datos_telefono': 'Pidiendo teléfono',
      'datos_direccion': 'Pidiendo dirección',
      'datos_ciudad': 'Pidiendo ciudad',
      'esperando_voucher': 'Esperando comprobante de pago'
    };

    let desc = descripciones[estado] || estado;
    if (pedido) desc += ` | Pedido: ${pedido.producto} x${pedido.cantidad}`;
    if (cliente?.nombre) desc += ` | Cliente: ${cliente.nombre}`;
    return desc;
  }

  async llamarGroq(prompt) {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 250,
        temperature: 0.6
      })
    });

    if (!response.ok) {
      throw new Error(`Groq error: ${response.status}`);
    }

    const data = await response.json();
    const texto = data.choices?.[0]?.message?.content || '';
    return this.parsearRespuesta(texto);
  }

  async llamarGemini(prompt) {
    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 250 }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini error: ${response.status}`);
    }

    const data = await response.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return this.parsearRespuesta(texto);
  }

  parsearRespuesta(texto) {
    try {
      let clean = texto.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const json = JSON.parse(match[0]);
        return {
          respuesta: json.respuesta || json.mensaje || '',
          accion: json.accion || 'continuar',
          datos: json.datos || {}
        };
      }
    } catch (e) {
      console.log('   ⚠️ Error parsing JSON:', e.message);
    }

    if (texto && texto.length > 0 && texto.length < 500) {
      return {
        respuesta: texto.replace(/[{}"]/g, '').trim(),
        accion: 'continuar',
        datos: {}
      };
    }

    return null;
  }

  /**
   * Respuestas locales MEJORADAS - más inteligentes
   */
  respuestaLocal(mensaje, contexto) {
    const msg = mensaje.toLowerCase().trim();
    const { productos = [], estadoActual = 'inicio', negocio } = contexto;

    // === SOLICITUD DE FOTOS/IMÁGENES DE PRODUCTOS ===
    // El cliente quiere VER fotos, no enviar
    if ((msg.includes('foto') || msg.includes('imagen') || msg.includes('ver')) && 
        (msg.includes('producto') || msg.includes('planta') || msg.includes('anturio') || 
         msg.includes('monstera') || msg.includes('cómo es') || msg.includes('como es'))) {
      return {
        respuesta: `Lo siento, por WhatsApp no puedo enviarte fotos de los productos 😅\n\nPero te puedo dar una descripción detallada o puedes visitarnos para verlos en persona. ¿Qué producto te interesa?`,
        accion: 'sin_fotos',
        datos: {}
      };
    }

    // === PREGUNTAS POR PRODUCTO ESPECÍFICO ===
    // Buscar si menciona algún producto
    const productoMencionado = this.buscarProductoEnMensaje(msg, productos);
    
    if (productoMencionado) {
      // Quiere info de un producto específico
      if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio') || msg.includes('cuesta') || msg.includes('vale')) {
        return {
          respuesta: `El *${productoMencionado.nombre}* cuesta S/${productoMencionado.precio} 💰\n\n¿Te interesa?`,
          accion: 'info_producto',
          datos: { producto: productoMencionado }
        };
      }
      
      if (msg.includes('quiero') || msg.includes('dame') || msg.includes('necesito') || msg.includes('comprar')) {
        return {
          respuesta: `¡Perfecto! *${productoMencionado.nombre}* a S/${productoMencionado.precio}\n\n¿Cuántas unidades deseas?`,
          accion: 'confirmar_compra',
          datos: { producto: productoMencionado }
        };
      }

      if (msg.includes('tienen') || msg.includes('hay') || msg.includes('tienes')) {
        const stock = productoMencionado.disponible || productoMencionado.stock || 0;
        if (stock > 0) {
          return {
            respuesta: `¡Sí tenemos! *${productoMencionado.nombre}* a S/${productoMencionado.precio}\nStock: ${stock} disponibles 📦\n\n¿Te interesa?`,
            accion: 'info_producto',
            datos: { producto: productoMencionado }
          };
        } else {
          return {
            respuesta: `😅 El *${productoMencionado.nombre}* está agotado por el momento.\n\n¿Te interesa otro producto?`,
            accion: 'continuar',
            datos: {}
          };
        }
      }

      // Solo mencionó el producto
      return {
        respuesta: `*${productoMencionado.nombre}*\nPrecio: S/${productoMencionado.precio}\nStock: ${productoMencionado.disponible || productoMencionado.stock || 'Disponible'}\n\n¿Lo quieres?`,
        accion: 'info_producto',
        datos: { producto: productoMencionado }
      };
    }

    // === SALUDOS ===
    if (/^(hola|buenos|buenas|hey|hi|alo|qué tal|que tal|buen día|buenas noches)/.test(msg)) {
      return {
        respuesta: `¡Hola! 👋 Soy el asistente de ${negocio?.nombre || 'la tienda'}.\n\n¿En qué te puedo ayudar?`,
        accion: 'continuar',
        datos: {}
      };
    }

    // === VER CATÁLOGO (explícito) ===
    if (msg.includes('catálogo') || msg.includes('catalogo') || msg.includes('productos') || 
        msg.includes('qué tienen') || msg.includes('que tienen') || msg.includes('qué venden') ||
        msg.includes('lista') || msg.includes('mostrar todo')) {
      return {
        respuesta: 'Te muestro nuestros productos:',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === PREGUNTAS GENERALES SIN PRODUCTO ESPECÍFICO ===
    if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio')) {
      return {
        respuesta: '¿De qué producto quieres saber el precio? 🤔',
        accion: 'preguntar',
        datos: {}
      };
    }

    if (msg.includes('tienen') || msg.includes('hay') || msg.includes('tienes') || msg.includes('venden')) {
      return {
        respuesta: '¿Qué producto estás buscando? 🌱',
        accion: 'preguntar',
        datos: {}
      };
    }

    // === PROCESO DE COMPRA ===
    if (msg.includes('cómo compro') || msg.includes('como compro') || msg.includes('cómo funciona') || msg.includes('como funciona')) {
      return {
        respuesta: '¡Es fácil! 😊\n\n1️⃣ Elige un producto\n2️⃣ Me dices la cantidad\n3️⃣ Pagas por Yape/Plin\n4️⃣ Envías foto del comprobante\n\n¿Qué te interesa?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === MÉTODOS DE PAGO ===
    if (msg.includes('pago') || msg.includes('yape') || msg.includes('plin') || msg.includes('transferencia')) {
      return {
        respuesta: '💳 Aceptamos Yape, Plin y transferencia bancaria.\n\n¿Quieres hacer un pedido?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === ENVÍO ===
    if (msg.includes('envío') || msg.includes('envio') || msg.includes('delivery') || msg.includes('despacho')) {
      return {
        respuesta: '🚚 Sí hacemos envíos. El costo depende de tu ubicación.\n\n¿Qué producto te interesa?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === CONTACTO HUMANO ===
    if (msg.includes('hablar') || msg.includes('persona') || msg.includes('humano') || msg.includes('asesor')) {
      return {
        respuesta: 'Te conecto con alguien del equipo 👤',
        accion: 'contactar',
        datos: {}
      };
    }

    // === AGRADECIMIENTOS ===
    if (msg.includes('gracias') || msg.includes('thanks') || msg.includes('genial') || msg.includes('perfecto') || msg.includes('ok')) {
      return {
        respuesta: '¡De nada! 😊 ¿Algo más en que te pueda ayudar?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === DESPEDIDAS ===
    if (msg.includes('chau') || msg.includes('adiós') || msg.includes('adios') || msg.includes('bye') || msg.includes('hasta luego')) {
      return {
        respuesta: '¡Hasta pronto! 👋 Escríbenos cuando quieras.',
        accion: 'continuar',
        datos: {}
      };
    }

    // === NÚMEROS ===
    if (/^\d+$/.test(msg)) {
      return {
        respuesta: null,
        accion: 'seleccionar_numero',
        datos: { numero: parseInt(msg) }
      };
    }

    // === AYUDA ===
    if (msg.includes('ayuda') || msg.includes('help') || msg.includes('no entiendo')) {
      return {
        respuesta: '¡Te ayudo! 😊\n\nPuedes preguntarme por:\n• Un producto específico\n• Precios\n• Formas de pago\n• Envíos\n\n¿Qué necesitas?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === DEFAULT - NO MOSTRAR CATÁLOGO ===
    return {
      respuesta: `No estoy seguro de entender 🤔\n\n¿Qué necesitas? Puedo ayudarte con información de productos, precios o pedidos.`,
      accion: 'preguntar',
      datos: {}
    };
  }

  /**
   * Buscar producto mencionado en el mensaje
   */
  buscarProductoEnMensaje(mensaje, productos) {
    if (!productos || productos.length === 0) return null;
    
    const msgLower = mensaje.toLowerCase();
    
    // Buscar coincidencia exacta o parcial
    for (const producto of productos) {
      const nombreLower = producto.nombre.toLowerCase();
      
      // Coincidencia exacta del nombre
      if (msgLower.includes(nombreLower)) {
        return producto;
      }
      
      // Buscar palabras clave del nombre del producto
      const palabrasProducto = nombreLower.split(/\s+/).filter(p => p.length > 3);
      for (const palabra of palabrasProducto) {
        if (msgLower.includes(palabra) && palabra !== 'para' && palabra !== 'como') {
          return producto;
        }
      }
    }
    
    return null;
  }
}

module.exports = new AIService();
