/**
 * APARTALO CORE - Servicio de IA Mejorado
 * 
 * IA contextual que entiende el flujo de compra y responde naturalmente
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
    
    // Manejar tipos especiales de mensaje
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

    // Mensaje de texto normal
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

    // Si estamos esperando voucher
    if (estadoActual === 'esperando_voucher') {
      return {
        respuesta: null, // El handler se encarga
        accion: 'procesar_voucher',
        datos: {}
      };
    }

    // Si estamos en otro estado, preguntar qué es
    if (caption) {
      return {
        respuesta: `Recibí tu imagen 📷\n\n"${caption}"\n\n¿En qué te puedo ayudar con esto?`,
        accion: 'continuar',
        datos: { tieneImagen: true, caption }
      };
    }

    return {
      respuesta: '¡Recibí tu imagen! 📷\n\n¿Es un comprobante de pago o quieres que te ayude con algo?',
      accion: 'preguntar_imagen',
      datos: { tieneImagen: true }
    };
  }

  /**
   * Manejar ubicación recibida
   */
  manejarUbicacion(mensaje, contexto) {
    const { estadoActual = 'inicio' } = contexto;
    console.log(`   📍 Ubicación recibida en estado: ${estadoActual}`);

    if (estadoActual === 'datos_direccion' || estadoActual === 'datos_ciudad') {
      return {
        respuesta: '¡Perfecto! Recibí tu ubicación 📍\n\n¿Puedes confirmarme la dirección exacta con número de casa/depto?',
        accion: 'guardar_ubicacion',
        datos: { tieneUbicacion: true }
      };
    }

    return {
      respuesta: '¡Gracias por compartir tu ubicación! 📍\n\n¿Quieres que te enviemos algo a esta dirección?',
      accion: 'continuar',
      datos: { tieneUbicacion: true }
    };
  }

  /**
   * Manejar documento recibido
   */
  manejarDocumento(mensaje, contexto) {
    return {
      respuesta: 'Recibí tu documento 📄\n\nPor ahora solo procesamos imágenes de comprobantes de pago.\n\n¿Puedes enviarlo como foto?',
      accion: 'continuar',
      datos: { tieneDocumento: true }
    };
  }

  /**
   * Manejar audio/voz recibido
   */
  manejarAudio(mensaje, contexto) {
    return {
      respuesta: '🎤 Recibí tu mensaje de voz.\n\nPor ahora no puedo escuchar audios, pero puedes escribirme y te ayudo con gusto 😊',
      accion: 'continuar',
      datos: { tieneAudio: true }
    };
  }

  /**
   * Construir prompt inteligente con contexto
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
Debes responder de forma NATURAL, CÁLIDA y BREVE (máximo 2-3 líneas).

PRODUCTOS DISPONIBLES:
${productosTexto || 'Sin productos cargados'}

CONTEXTO ACTUAL:
${contextoEstado}

REGLAS IMPORTANTES:
1. Sé amable, usa emojis con moderación
2. Si preguntan por algo que no tenemos, sugiere alternativas o el catálogo
3. Si quieren comprar, guíalos al catálogo
4. Si piden foto/imagen de algo, explica que pueden enviar comprobantes
5. Si no entiendes, pide aclaración amablemente
6. Nunca inventes productos o precios
7. Si mencionan "mamá", "papá", "regalo", "cumpleaños" → sugiere el catálogo como regalo

ACCIONES (responde en JSON):
- ver_catalogo: Mostrar lista de productos
- buscar_producto: Buscar producto {buscar: "término"}
- contactar: Conectar con humano
- continuar: Solo responder sin acción especial
- menu: Mostrar menú principal
- solicitar_foto: Pedir que envíen una imagen
- explicar_proceso: Explicar cómo funciona la compra

MENSAJE DEL CLIENTE: "${mensaje}"

Responde SOLO con JSON válido:
{"respuesta": "tu mensaje", "accion": "nombre_accion", "datos": {}}`;
  }

  /**
   * Describir el estado actual para contexto
   */
  describirEstado(estado, pedido, cliente) {
    const descripciones = {
      'inicio': 'El cliente acaba de iniciar conversación',
      'menu': 'El cliente está viendo el menú principal',
      'seleccion_producto': 'El cliente está eligiendo un producto del catálogo',
      'cantidad': 'El cliente debe indicar cuántas unidades quiere',
      'confirmar_pedido': 'El cliente debe confirmar su pedido',
      'datos_nombre': 'Necesitamos el nombre del cliente para el envío',
      'datos_telefono': 'Necesitamos el teléfono del cliente',
      'datos_direccion': 'Necesitamos la dirección de envío',
      'datos_ciudad': 'Necesitamos la ciudad/distrito del cliente',
      'esperando_voucher': 'El cliente debe enviar foto del comprobante de pago'
    };

    let descripcion = descripciones[estado] || `Estado: ${estado}`;

    if (pedido) {
      descripcion += `\nPedido en proceso: ${pedido.producto} x${pedido.cantidad} = S/${pedido.total}`;
    }

    if (cliente?.nombre) {
      descripcion += `\nCliente: ${cliente.nombre}`;
    }

    return descripcion;
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
        max_tokens: 300,
        temperature: 0.7
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
        generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
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
   * Respuestas locales mejoradas
   */
  respuestaLocal(mensaje, contexto) {
    const msg = mensaje.toLowerCase().trim();
    const { productos = [], estadoActual = 'inicio' } = contexto;

    // === SALUDOS ===
    if (/^(hola|buenos|buenas|hey|hi|alo|qué tal|que tal)/.test(msg)) {
      return {
        respuesta: '¡Hola! 👋 ¿En qué te puedo ayudar hoy?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === SOLICITUD DE FOTOS/IMÁGENES ===
    if (msg.includes('foto') || msg.includes('imagen') || msg.includes('picture') || msg.includes('ver')) {
      if (msg.includes('producto') || msg.includes('catalogo') || msg.includes('catálogo')) {
        return {
          respuesta: '📸 Te muestro nuestro catálogo con los productos disponibles:',
          accion: 'ver_catalogo',
          datos: {}
        };
      }
      return {
        respuesta: '📸 ¡Claro! Si quieres ver nuestros productos, te muestro el catálogo.\n\nSi necesitas enviar un comprobante de pago, puedes enviarlo directamente como imagen.',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === PREGUNTAS POR PRODUCTOS ===
    if (msg.includes('tienen') || msg.includes('hay') || msg.includes('venden') || msg.includes('tienes')) {
      const palabras = msg.split(/\s+/);
      for (const palabra of palabras) {
        if (palabra.length > 3 && !['tienen', 'tienes', 'venden', 'tienen'].includes(palabra)) {
          const encontrado = productos.find(p => 
            p.nombre.toLowerCase().includes(palabra)
          );
          if (encontrado) {
            return {
              respuesta: `¡Sí tenemos! 🎉\n\n*${encontrado.nombre}*\nPrecio: S/${encontrado.precio}\n\n¿Te interesa?`,
              accion: 'buscar_producto',
              datos: { buscar: palabra, producto: encontrado }
            };
          }
        }
      }
      
      return {
        respuesta: 'Déjame mostrarte lo que tenemos disponible 📦',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === PRECIOS ===
    if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio') || msg.includes('cuesta') || msg.includes('vale')) {
      return {
        respuesta: 'Te muestro los precios de nuestros productos 💰',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === INTENCIÓN DE COMPRA ===
    if (msg.includes('quiero') || msg.includes('necesito') || msg.includes('comprar') || msg.includes('pedir') || msg.includes('ordenar')) {
      return {
        respuesta: '¡Perfecto! 🛒 Te muestro lo que tenemos:',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === REGALOS ===
    if (msg.includes('regalo') || msg.includes('mamá') || msg.includes('mama') || msg.includes('papá') || msg.includes('papa') || msg.includes('cumpleaños') || msg.includes('cumple')) {
      return {
        respuesta: '¡Qué lindo detalle! 🎁 Te muestro opciones perfectas para regalar:',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // === PROCESO DE COMPRA ===
    if (msg.includes('cómo compro') || msg.includes('como compro') || msg.includes('cómo funciona') || msg.includes('como funciona') || msg.includes('proceso')) {
      return {
        respuesta: '¡Es muy fácil! 😊\n\n1️⃣ Elige del catálogo\n2️⃣ Indica la cantidad\n3️⃣ Confirma tus datos\n4️⃣ Paga por Yape/Plin/transferencia\n5️⃣ Envía foto del comprobante\n\n¿Empezamos?',
        accion: 'explicar_proceso',
        datos: {}
      };
    }

    // === MÉTODOS DE PAGO ===
    if (msg.includes('pago') || msg.includes('yape') || msg.includes('plin') || msg.includes('transferencia') || msg.includes('efectivo')) {
      return {
        respuesta: '💳 Aceptamos:\n• Yape\n• Plin\n• Transferencia bancaria\n\n¿Quieres hacer un pedido?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === ENVÍO ===
    if (msg.includes('envío') || msg.includes('envio') || msg.includes('delivery') || msg.includes('llega') || msg.includes('despacho')) {
      return {
        respuesta: '🚚 Hacemos envíos a todo Lima y provincias.\n\nEl costo depende de tu ubicación. ¿Quieres ver nuestros productos?',
        accion: 'continuar',
        datos: {}
      };
    }

    // === AYUDA ===
    if (msg.includes('ayuda') || msg.includes('help') || msg.includes('no entiendo') || msg.includes('no sé') || msg.includes('no se')) {
      return {
        respuesta: '¡Con gusto te ayudo! 😊\n\nPuedes:\n• Ver el *catálogo*\n• Preguntarme por un producto\n• Escribir *menu* para ver opciones',
        accion: 'continuar',
        datos: {}
      };
    }

    // === CONTACTO HUMANO ===
    if (msg.includes('hablar') || msg.includes('persona') || msg.includes('humano') || msg.includes('asesor') || msg.includes('vendedor')) {
      return {
        respuesta: 'Te conecto con alguien del equipo 👤',
        accion: 'contactar',
        datos: {}
      };
    }

    // === AGRADECIMIENTOS ===
    if (msg.includes('gracias') || msg.includes('thanks') || msg.includes('genial') || msg.includes('perfecto')) {
      return {
        respuesta: '¡De nada! 😊 ¿Hay algo más en que pueda ayudarte?',
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

    // === NÚMEROS (posible selección de producto) ===
    if (/^\d+$/.test(msg)) {
      return {
        respuesta: null, // Dejar que el handler lo maneje
        accion: 'seleccionar_numero',
        datos: { numero: parseInt(msg) }
      };
    }

    // === DEFAULT ===
    return {
      respuesta: `No estoy seguro de entender 🤔\n\n¿Quieres ver nuestro *catálogo* o necesitas ayuda con algo específico?`,
      accion: 'continuar',
      datos: {}
    };
  }
}

module.exports = new AIService();
