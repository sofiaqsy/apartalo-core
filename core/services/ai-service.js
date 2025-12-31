/**
 * APARTALO CORE - Servicio de IA v3
 * 
 * IA contextual con soporte para envío de fotos de productos
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

    if (estadoActual === 'esperando_voucher') {
      return {
        respuesta: null,
        accion: 'procesar_voucher',
        datos: {}
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
        respuesta: '¡Recibí tu ubicación! 📍\n\n¿Puedes confirmar la dirección exacta?',
        accion: 'guardar_ubicacion',
        datos: { tieneUbicacion: true }
      };
    }

    return {
      respuesta: '¡Gracias por tu ubicación! 📍',
      accion: 'continuar',
      datos: { tieneUbicacion: true }
    };
  }

  manejarDocumento(mensaje, contexto) {
    return {
      respuesta: 'Recibí tu documento 📄\n\nSi es un comprobante, ¿puedes enviarlo como foto?',
      accion: 'continuar',
      datos: { tieneDocumento: true }
    };
  }

  manejarAudio(mensaje, contexto) {
    return {
      respuesta: '🎤 No puedo escuchar audios aún.\n\n¿Puedes escribirme?',
      accion: 'continuar',
      datos: { tieneAudio: true }
    };
  }

  /**
   * Construir prompt inteligente
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
      `- ${p.nombre}: S/${p.precio} (tiene foto: ${p.imagenUrl ? 'sí' : 'no'})`
    ).join('\n');

    const contextoEstado = this.describirEstado(estadoActual, pedidoActual, datosCliente);

    return `Eres el asistente de "${negocio?.nombre || 'la tienda'}" en WhatsApp.

PRODUCTOS:
${productosTexto || 'Sin productos'}

CONTEXTO: ${contextoEstado}

REGLAS:
1. NO muestres catálogo a menos que lo pidan explícitamente
2. Si piden "foto" o "ver" un producto → TENEMOS fotos, usar acción "enviar_foto"
3. Si preguntan por producto específico → dar info de ESE producto
4. Si no es claro → PREGUNTAR qué necesitan
5. Respuestas cortas (2-3 líneas)

ACCIONES (JSON):
- ver_catalogo: SOLO si piden ver todos los productos
- enviar_foto: Enviar foto de un producto {producto: "nombre del producto"}
- info_producto: Info sin foto {producto: "nombre"}
- confirmar_compra: Quiere comprar {producto: "nombre"}
- preguntar: Pedir aclaración
- contactar: Hablar con humano
- continuar: Solo responder

MENSAJE: "${mensaje}"

JSON: {"respuesta": "...", "accion": "...", "datos": {}}`;
  }

  describirEstado(estado, pedido, cliente) {
    const descripciones = {
      'inicio': 'Conversación nueva',
      'menu': 'Viendo menú',
      'seleccion_producto': 'Eligiendo producto',
      'cantidad': 'Indicando cantidad',
      'confirmar_pedido': 'Confirmando pedido',
      'datos_nombre': 'Pidiendo nombre',
      'datos_telefono': 'Pidiendo teléfono',
      'datos_direccion': 'Pidiendo dirección',
      'datos_ciudad': 'Pidiendo ciudad',
      'esperando_voucher': 'Esperando comprobante'
    };

    let desc = descripciones[estado] || estado;
    if (pedido) desc += ` | Pedido: ${pedido.producto}`;
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
   * Respuestas locales MEJORADAS con soporte para fotos
   */
  respuestaLocal(mensaje, contexto) {
    const msg = mensaje.toLowerCase().trim();
    const { productos = [], estadoActual = 'inicio', negocio } = contexto;

    // === SOLICITUD DE FOTOS DE PRODUCTOS ===
    if ((msg.includes('foto') || msg.includes('imagen') || msg.includes('ver') || msg.includes('muestra') || msg.includes('enseña')) && 
        !msg.includes('comprobante') && !msg.includes('voucher') && !msg.includes('pago')) {
      
      // Buscar qué producto quiere ver
      const productoMencionado = this.buscarProductoEnMensaje(msg, productos);
      
      if (productoMencionado) {
        if (productoMencionado.imagenUrl) {
          return {
            respuesta: `¡Aquí tienes! 📷`,
            accion: 'enviar_foto',
            datos: { producto: productoMencionado }
          };
        } else {
          return {
            respuesta: `No tengo foto del *${productoMencionado.nombre}* 😅\n\nPero te cuento: cuesta S/${productoMencionado.precio}. ¿Te interesa?`,
            accion: 'info_producto',
            datos: { producto: productoMencionado }
          };
        }
      }
      
      // Piden foto pero no especifican producto
      return {
        respuesta: '📷 ¿De qué producto quieres ver la foto?',
        accion: 'preguntar',
        datos: {}
      };
    }

    // === PREGUNTAS POR PRODUCTO ESPECÍFICO ===
    const productoMencionado = this.buscarProductoEnMensaje(msg, productos);
    
    if (productoMencionado) {
      // Quiere precio
      if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio') || msg.includes('cuesta') || msg.includes('vale')) {
        return {
          respuesta: `*${productoMencionado.nombre}* cuesta S/${productoMencionado.precio} 💰\n\n¿Te interesa?`,
          accion: 'info_producto',
          datos: { producto: productoMencionado }
        };
      }
      
      // Quiere comprar
      if (msg.includes('quiero') || msg.includes('dame') || msg.includes('necesito') || msg.includes('comprar')) {
        return {
          respuesta: `¡Perfecto! *${productoMencionado.nombre}* a S/${productoMencionado.precio}\n\n¿Cuántas unidades?`,
          accion: 'confirmar_compra',
          datos: { producto: productoMencionado }
        };
      }

      // Pregunta si tienen
      if (msg.includes('tienen') || msg.includes('hay') || msg.includes('tienes')) {
        const stock = productoMencionado.disponible || productoMencionado.stock || 0;
        if (stock > 0) {
          // Si tiene foto, enviarla
          if (productoMencionado.imagenUrl) {
            return {
              respuesta: `¡Sí tenemos! 🎉`,
              accion: 'enviar_foto',
              datos: { producto: productoMencionado }
            };
          }
          return {
            respuesta: `¡Sí! *${productoMencionado.nombre}* a S/${productoMencionado.precio}\nStock: ${stock} disponibles 📦\n\n¿Te interesa?`,
            accion: 'info_producto',
            datos: { producto: productoMencionado }
          };
        } else {
          return {
            respuesta: `😅 *${productoMencionado.nombre}* está agotado.\n\n¿Te interesa otro?`,
            accion: 'continuar',
            datos: {}
          };
        }
      }

      // Solo mencionó el producto - enviar foto si tiene
      if (productoMencionado.imagenUrl) {
        return {
          respuesta: `*${productoMencionado.nombre}*\nS/${productoMencionado.precio}`,
          accion: 'enviar_foto',
          datos: { producto: productoMencionado }
        };
      }
      
      return {
        respuesta: `*${productoMencionado.nombre}*\nPrecio: S/${productoMencionado.precio}\nStock: ${productoMencionado.disponible || productoMencionado.stock || 'Disponible'}\n\n¿Lo quieres?`,
        accion: 'info_producto',
        datos: { producto: productoMencionado }
      };
    }

    // === SALUDOS ===
    if (/^(hola|buenos|buenas|hey|hi|alo|qué tal|que tal)/.test(msg)) {
      return {
        respuesta: `¡Hola! 👋 Soy el asistente de ${negocio?.nombre || 'la tienda'}.\n\n¿En qué te ayudo?`,
        accion: 'continuar',
        datos: {}
      };
    }

    // === VER CATÁLOGO (explícito) ===
    if (msg.includes('catálogo') || msg.includes('catalogo') || msg.includes('productos') || 
        msg.includes('qué tienen') || msg.includes('que tienen') || msg.includes('lista') || msg.includes('mostrar todo')) {
      return {
        respuesta: 'Te muestro nuestros productos:',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === PREGUNTAS SIN PRODUCTO ESPECÍFICO ===
    if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio')) {
      return {
        respuesta: '¿De qué producto quieres saber el precio? 🤔',
        accion: 'preguntar',
        datos: {}
      };
    }

    if (msg.includes('tienen') || msg.includes('hay') || msg.includes('tienes') || msg.includes('venden')) {
      return {
        respuesta: '¿Qué producto buscas? 🌱',
        accion: 'preguntar',
        datos: {}
      };
    }

    // === PROCESO DE COMPRA ===
    if (msg.includes('cómo compro') || msg.includes('como compro') || msg.includes('cómo funciona')) {
      return {
        respuesta: '¡Es fácil! 😊\n\n1️⃣ Elige un producto\n2️⃣ Indicas cantidad\n3️⃣ Pagas por Yape/Plin\n4️⃣ Envías foto del comprobante\n\n¿Qué te interesa?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === MÉTODOS DE PAGO ===
    if (msg.includes('pago') || msg.includes('yape') || msg.includes('plin') || msg.includes('transferencia')) {
      return {
        respuesta: '💳 Aceptamos Yape, Plin y transferencia.\n\n¿Quieres hacer un pedido?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === ENVÍO ===
    if (msg.includes('envío') || msg.includes('envio') || msg.includes('delivery')) {
      return {
        respuesta: '🚚 Sí hacemos envíos. El costo depende de tu zona.\n\n¿Qué producto te interesa?',
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
    if (msg.includes('gracias') || msg.includes('genial') || msg.includes('perfecto') || msg.includes('ok')) {
      return {
        respuesta: '¡De nada! 😊 ¿Algo más?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === DESPEDIDAS ===
    if (msg.includes('chau') || msg.includes('adiós') || msg.includes('adios') || msg.includes('bye')) {
      return {
        respuesta: '¡Hasta pronto! 👋',
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
    if (msg.includes('ayuda') || msg.includes('help')) {
      return {
        respuesta: '¡Te ayudo! 😊\n\nPuedo:\n• Mostrarte fotos de productos\n• Darte precios\n• Ayudarte a comprar\n\n¿Qué necesitas?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === DEFAULT ===
    return {
      respuesta: `No entendí bien 🤔\n\n¿Qué necesitas? Puedo mostrarte productos, fotos o ayudarte a comprar.`,
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
    
    // Buscar coincidencia
    for (const producto of productos) {
      const nombreLower = producto.nombre.toLowerCase();
      
      // Coincidencia del nombre completo
      if (msgLower.includes(nombreLower)) {
        return producto;
      }
      
      // Buscar palabras clave del nombre (mínimo 4 caracteres)
      const palabrasProducto = nombreLower.split(/\s+/).filter(p => p.length >= 4);
      for (const palabra of palabrasProducto) {
        // Evitar palabras comunes
        if (['para', 'como', 'una', 'uno', 'los', 'las', 'del', 'planta', 'maceta'].includes(palabra)) continue;
        
        if (msgLower.includes(palabra)) {
          return producto;
        }
      }
    }
    
    return null;
  }
}

module.exports = new AIService();
