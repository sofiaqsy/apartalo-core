/**
 * APARTALO CORE - Servicio de IA v9
 * 
 * Arquitectura: IA-first
 * La IA siempre procesa el mensaje y decide la acción.
 * Respuestas locales solo como fallback si la IA falla.
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
    console.log('AI Service inicializando...');
    console.log(`   GROQ_API_KEY: ${GROQ_API_KEY ? 'SET' : 'NOT SET'}`);
    console.log(`   GEMINI_API_KEY: ${GEMINI_API_KEY ? 'SET' : 'NOT SET'}`);
    
    if (GROQ_API_KEY) {
      this.provider = 'groq';
      this.initialized = true;
      console.log('IA: Groq configurado');
      return true;
    }
    
    if (GEMINI_API_KEY) {
      this.provider = 'gemini';
      this.initialized = true;
      console.log('IA: Gemini configurado');
      return true;
    }

    console.log('IA: Sin API keys - usando respuestas locales como fallback');
    return false;
  }

  /**
   * Procesar mensaje - SIEMPRE intenta usar IA primero
   */
  async procesarMensaje(mensaje, contexto = {}) {
    const { tipoMensaje = 'text' } = contexto;
    
    console.log(`\nAI procesarMensaje: "${mensaje}" (tipo: ${tipoMensaje})`);
    
    // Tipos especiales que no necesitan IA
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

    // SIEMPRE intentar IA primero si está configurada
    if (this.initialized) {
      try {
        const prompt = this.construirPrompt(mensaje, contexto);
        
        let resultado;
        if (this.provider === 'groq') {
          resultado = await this.llamarGroq(prompt);
        } else {
          resultado = await this.llamarGemini(prompt);
        }

        if (resultado && resultado.accion) {
          console.log(`   IA decidió: ${resultado.accion}`);
          return resultado;
        }
      } catch (error) {
        console.error('Error IA:', error.message);
      }
    }

    // Fallback: respuestas locales básicas
    console.log('   Usando fallback local');
    return this.fallbackLocal(mensaje, contexto);
  }

  /**
   * Construir prompt con contexto completo para que la IA decida
   */
  construirPrompt(mensaje, contexto) {
    const { 
      negocio, 
      productos = [], 
      pedidosActivos = [],
      estadoActual = 'inicio',
      datosCliente = {},
      pedidoActual = null
    } = contexto;
    
    // Resumen de productos disponibles
    const productosTexto = productos.slice(0, 10).map(p => 
      `- ${p.nombre}: S/${p.precio}`
    ).join('\n');

    // Resumen de pedidos activos del cliente
    const pedidosTexto = pedidosActivos.length > 0 
      ? pedidosActivos.map(p => `- ${p.id}: ${p.estado}`).join('\n')
      : 'Sin pedidos activos';

    // Estado actual de la conversación
    const estadoTexto = this.describirEstado(estadoActual, pedidoActual, datosCliente);

    return `Eres el asistente virtual de "${negocio?.nombre || 'la tienda'}" en WhatsApp.
Tu trabajo es entender la INTENCIÓN del cliente y responder con la ACCIÓN correcta.

CONTEXTO DEL CLIENTE:
- Estado conversación: ${estadoTexto}
- Pedidos activos: ${pedidosTexto}
${datosCliente?.nombre ? `- Nombre: ${datosCliente.nombre}` : '- Cliente nuevo'}

PRODUCTOS DISPONIBLES:
${productosTexto || 'Sin productos'}

REGLAS:
1. NO uses emojis
2. Respuestas cortas (máximo 2-3 líneas)
3. Interpreta la INTENCIÓN, no las palabras exactas

ACCIONES DISPONIBLES (responde SOLO con una):
- "menu": Saludos simples (hola, buenos días) → mostrar menú principal
- "ver_catalogo": Quiere comprar algo nuevo, ver productos, hacer pedido nuevo
- "ver_pedidos": Consultar estado de sus pedidos existentes
- "enviar_foto": Pide foto de un producto específico → incluir {producto: "nombre"}
- "info_producto": Pregunta sobre un producto → incluir {producto: "nombre"}
- "confirmar_compra": Quiere comprar un producto específico → incluir {producto: "nombre"}
- "contactar": Quiere hablar con una persona
- "continuar": Conversación general, agradecer, etc.
- "preguntar": Necesitas más información para ayudar

EJEMPLOS DE INTERPRETACIÓN:
- "Un nuevo pedido" → ver_catalogo (quiere comprar)
- "Quiero hacer un pedido" → ver_catalogo (quiere comprar)
- "Mis pedidos" → ver_pedidos (consultar existentes)
- "Qué pedidos tengo" → ver_pedidos (consultar existentes)
- "Hola" → menu
- "Tienen monstera?" → info_producto o enviar_foto con {producto: "Monstera"}
- "Cuánto cuesta X" → info_producto con {producto: "X"}
- "Quiero una monstera" → confirmar_compra con {producto: "Monstera"}

MENSAJE DEL CLIENTE: "${mensaje}"

Responde SOLO en formato JSON:
{"respuesta": "texto corto o vacío", "accion": "accion", "datos": {}}`;
  }

  describirEstado(estado, pedido, cliente) {
    const descripciones = {
      'inicio': 'Conversación nueva',
      'menu': 'Viendo menú principal',
      'seleccion_producto': 'Eligiendo producto del catálogo',
      'cantidad': 'Indicando cantidad',
      'confirmar_pedido': 'Confirmando pedido',
      'datos_nombre': 'Pidiendo nombre',
      'datos_telefono': 'Pidiendo teléfono',
      'datos_direccion': 'Pidiendo dirección',
      'datos_ciudad': 'Pidiendo ciudad',
      'esperando_voucher': 'Esperando comprobante de pago'
    };

    let desc = descripciones[estado] || estado;
    if (pedido) desc += ` | Pedido en curso: ${pedido.producto}`;
    return desc;
  }

  // ============================================
  // LLAMADAS A PROVEEDORES DE IA
  // ============================================

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
        max_tokens: 200,
        temperature: 0.3  // Más determinístico
      })
    });

    if (!response.ok) {
      throw new Error(`Groq error: ${response.status}`);
    }

    const data = await response.json();
    const texto = data.choices?.[0]?.message?.content || '';
    return this.parsearRespuestaIA(texto);
  }

  async llamarGemini(prompt) {
    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.3,  // Más determinístico
          maxOutputTokens: 200 
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini error: ${response.status}`);
    }

    const data = await response.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return this.parsearRespuestaIA(texto);
  }

  parsearRespuestaIA(texto) {
    try {
      // Limpiar markdown
      let clean = texto.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      
      // Buscar JSON
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const json = JSON.parse(match[0]);
        return {
          respuesta: json.respuesta || '',
          accion: json.accion || 'continuar',
          datos: json.datos || {}
        };
      }
    } catch (e) {
      console.log('   Error parsing JSON:', e.message);
    }
    return null;
  }

  // ============================================
  // MANEJADORES DE TIPOS ESPECIALES
  // ============================================

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
      respuesta: 'Recibí tu imagen\n\n¿Es un comprobante de pago?',
      accion: 'preguntar_imagen',
      datos: { tieneImagen: true }
    };
  }

  manejarUbicacion(mensaje, contexto) {
    const { estadoActual = 'inicio' } = contexto;

    if (estadoActual === 'datos_direccion' || estadoActual === 'datos_ciudad') {
      return {
        respuesta: 'Recibí tu ubicación\n\n¿Puedes confirmar la dirección exacta?',
        accion: 'guardar_ubicacion',
        datos: { tieneUbicacion: true }
      };
    }

    return {
      respuesta: 'Gracias por tu ubicación',
      accion: 'continuar',
      datos: { tieneUbicacion: true }
    };
  }

  manejarDocumento(mensaje, contexto) {
    return {
      respuesta: 'Recibí tu documento\n\nSi es un comprobante, ¿puedes enviarlo como foto?',
      accion: 'continuar',
      datos: { tieneDocumento: true }
    };
  }

  manejarAudio(mensaje, contexto) {
    return {
      respuesta: 'No puedo escuchar audios aún.\n\n¿Puedes escribirme?',
      accion: 'continuar',
      datos: { tieneAudio: true }
    };
  }

  // ============================================
  // FALLBACK LOCAL (solo si IA falla)
  // ============================================

  fallbackLocal(mensaje, contexto) {
    const msg = mensaje.toLowerCase().trim();
    const { productos = [], negocio } = contexto;

    // Saludos simples
    if (/^(hola|buenos|buenas|hey|hi|alo)/.test(msg)) {
      return { respuesta: '', accion: 'menu', datos: {} };
    }

    // Números (selección de producto)
    if (/^\d+$/.test(msg)) {
      return { 
        respuesta: null, 
        accion: 'seleccionar_numero', 
        datos: { numero: parseInt(msg) } 
      };
    }

    // Palabras clave obvias
    if (msg.includes('catálogo') || msg.includes('catalogo') || msg.includes('productos')) {
      return { respuesta: '', accion: 'ver_catalogo', datos: {} };
    }

    if (msg.includes('mis pedidos') || msg.includes('mi pedido')) {
      return { respuesta: '', accion: 'ver_pedidos', datos: {} };
    }

    // Default: preguntar
    return {
      respuesta: '¿En qué te puedo ayudar?\n\nPuedo mostrarte productos o el estado de tus pedidos.',
      accion: 'preguntar',
      datos: {}
    };
  }
}

module.exports = new AIService();
