/**
 * APARTALO CORE - Servicio de IA v7
 * 
 * Mejoras: detección "nuevo pedido", saludos limpios
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

    console.log('IA: Sin API keys - usando respuestas locales');
    return false;
  }

  async procesarMensaje(mensaje, contexto = {}) {
    const { tipoMensaje = 'text' } = contexto;
    
    console.log(`AI procesarMensaje: "${mensaje}" (tipo: ${tipoMensaje})`);
    
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
        console.log(`   IA resultado: ${resultado.accion}`);
        return resultado;
      }
    } catch (error) {
      console.error('Error IA:', error.message);
    }

    return this.respuestaLocal(mensaje, contexto);
  }

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

REGLAS IMPORTANTES:
1. NO uses emojis en las respuestas
2. NO muestres información de stock al cliente
3. Si piden "mis pedidos", "estado de pedido", "qué pedidos tengo" -> usar acción "ver_pedidos"
4. Si piden "nuevo pedido", "quiero comprar", "hacer pedido" -> usar acción "ver_catalogo"
5. Si piden "listame", "qué tipos", "cuáles hay" -> usar acción "ver_catalogo"
6. Si piden "foto" o "ver" un producto específico -> usar acción "enviar_foto"
7. Si preguntan por producto específico -> dar info de ESE producto (solo nombre y precio)
8. Respuestas cortas y profesionales (2-3 líneas máximo)

ACCIONES (JSON):
- ver_pedidos: Consultar pedidos del cliente
- ver_catalogo: Si piden ver productos, listar, tipos disponibles, nuevo pedido
- enviar_foto: Enviar foto de un producto {producto: "nombre"}
- info_producto: Info sin foto {producto: "nombre"}
- confirmar_compra: Quiere comprar {producto: "nombre"}
- preguntar: Pedir aclaración
- contactar: Hablar con humano
- menu: Mostrar menú principal (solo para saludos simples como "hola")
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
      console.log('   Error parsing JSON:', e.message);
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

  respuestaLocal(mensaje, contexto) {
    const msg = mensaje.toLowerCase().trim();
    const { productos = [], estadoActual = 'inicio', negocio } = contexto;

    // ========== NUEVO PEDIDO / QUIERO COMPRAR ==========
    if (this.quiereNuevoPedido(msg)) {
      return {
        respuesta: '',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // ========== CONSULTA DE PEDIDOS ==========
    if (this.quiereVerPedidos(msg)) {
      return {
        respuesta: '',
        accion: 'ver_pedidos',
        datos: {}
      };
    }

    // ========== SOLICITUD DE LISTAR/VER CATÁLOGO ==========
    if (this.quiereVerCatalogo(msg)) {
      return {
        respuesta: '',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // ========== SOLICITUD DE FOTOS ==========
    if ((msg.includes('foto') || msg.includes('imagen') || msg.includes('muestra') || msg.includes('enseña')) && 
        !msg.includes('comprobante') && !msg.includes('voucher') && !msg.includes('pago')) {
      
      const productoMencionado = this.buscarProductoEnMensaje(msg, productos);
      
      if (productoMencionado) {
        if (productoMencionado.imagenUrl) {
          return {
            respuesta: '',
            accion: 'enviar_foto',
            datos: { producto: productoMencionado }
          };
        } else {
          return {
            respuesta: `No tengo foto de *${productoMencionado.nombre}*\n\nPrecio: S/${productoMencionado.precio}\n\n¿Te interesa?`,
            accion: 'info_producto',
            datos: { producto: productoMencionado }
          };
        }
      }
      
      return {
        respuesta: '¿De qué producto quieres ver la foto?',
        accion: 'preguntar',
        datos: {}
      };
    }

    // ========== PREGUNTAS POR PRODUCTO ESPECÍFICO ==========
    const productoMencionado = this.buscarProductoEnMensaje(msg, productos);
    
    if (productoMencionado) {
      if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio') || msg.includes('cuesta') || msg.includes('vale')) {
        return {
          respuesta: `*${productoMencionado.nombre}*\nS/${productoMencionado.precio}\n\n¿Te interesa?`,
          accion: 'info_producto',
          datos: { producto: productoMencionado }
        };
      }
      
      if (msg.includes('quiero') || msg.includes('dame') || msg.includes('necesito') || msg.includes('comprar')) {
        return {
          respuesta: `*${productoMencionado.nombre}* - S/${productoMencionado.precio}\n\n¿Cuántas unidades?`,
          accion: 'confirmar_compra',
          datos: { producto: productoMencionado }
        };
      }

      if (msg.includes('tienen') || msg.includes('hay') || msg.includes('tienes')) {
        const stock = productoMencionado.disponible || productoMencionado.stock || 0;
        if (stock > 0) {
          if (productoMencionado.imagenUrl) {
            return {
              respuesta: 'Sí tenemos',
              accion: 'enviar_foto',
              datos: { producto: productoMencionado }
            };
          }
          return {
            respuesta: `Sí, *${productoMencionado.nombre}* a S/${productoMencionado.precio}\n\n¿Te interesa?`,
            accion: 'info_producto',
            datos: { producto: productoMencionado }
          };
        } else {
          return {
            respuesta: `*${productoMencionado.nombre}* está agotado.\n\n¿Te interesa otro producto?`,
            accion: 'continuar',
            datos: {}
          };
        }
      }

      if (productoMencionado.imagenUrl) {
        return {
          respuesta: `*${productoMencionado.nombre}*\nS/${productoMencionado.precio}`,
          accion: 'enviar_foto',
          datos: { producto: productoMencionado }
        };
      }
      
      return {
        respuesta: `*${productoMencionado.nombre}*\nS/${productoMencionado.precio}\n\n¿Te interesa?`,
        accion: 'info_producto',
        datos: { producto: productoMencionado }
      };
    }

    // ========== SALUDOS (van al menú principal) ==========
    if (/^(hola|buenos días|buenas tardes|buenas noches|hey|hi|alo|buen día)$/i.test(msg) ||
        /^(hola|buenos|buenas|buen)\s*$/i.test(msg)) {
      return {
        respuesta: '',
        accion: 'menu',
        datos: {}
      };
    }

    // ========== PREGUNTAS SIN PRODUCTO ==========
    if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio')) {
      return {
        respuesta: '¿De qué producto quieres saber el precio?',
        accion: 'preguntar',
        datos: {}
      };
    }

    if (msg.includes('tienen') || msg.includes('hay') || msg.includes('tienes') || msg.includes('venden')) {
      return {
        respuesta: '¿Qué producto buscas?',
        accion: 'preguntar',
        datos: {}
      };
    }

    // ========== PROCESO DE COMPRA ==========
    if (msg.includes('cómo compro') || msg.includes('como compro') || msg.includes('cómo funciona')) {
      return {
        respuesta: 'Es fácil:\n\n1. Elige un producto\n2. Indicas cantidad\n3. Pagas por Yape/Plin\n4. Envías foto del comprobante\n\n¿Qué te interesa?',
        accion: 'continuar',
        datos: {}
      };
    }

    // ========== MÉTODOS DE PAGO ==========
    if (msg.includes('pago') || msg.includes('yape') || msg.includes('plin') || msg.includes('transferencia')) {
      return {
        respuesta: 'Aceptamos Yape, Plin y transferencia.\n\n¿Quieres hacer un pedido?',
        accion: 'continuar',
        datos: {}
      };
    }

    // ========== ENVÍO ==========
    if (msg.includes('envío') || msg.includes('envio') || msg.includes('delivery')) {
      return {
        respuesta: 'Sí hacemos envíos. El costo depende de tu zona.\n\n¿Qué producto te interesa?',
        accion: 'continuar',
        datos: {}
      };
    }

    // ========== CONTACTO HUMANO ==========
    if (msg.includes('hablar') || msg.includes('persona') || msg.includes('humano') || msg.includes('asesor')) {
      return {
        respuesta: 'Te conecto con alguien del equipo',
        accion: 'contactar',
        datos: {}
      };
    }

    // ========== AGRADECIMIENTOS ==========
    if (msg.includes('gracias') || msg.includes('genial') || msg.includes('perfecto') || msg.includes('ok')) {
      return {
        respuesta: 'De nada. ¿Algo más?',
        accion: 'continuar',
        datos: {}
      };
    }

    // ========== DESPEDIDAS ==========
    if (msg.includes('chau') || msg.includes('adiós') || msg.includes('adios') || msg.includes('bye')) {
      return {
        respuesta: 'Hasta pronto',
        accion: 'continuar',
        datos: {}
      };
    }

    // ========== NÚMEROS ==========
    if (/^\d+$/.test(msg)) {
      return {
        respuesta: null,
        accion: 'seleccionar_numero',
        datos: { numero: parseInt(msg) }
      };
    }

    // ========== AYUDA ==========
    if (msg.includes('ayuda') || msg.includes('help')) {
      return {
        respuesta: 'Te ayudo.\n\nPuedo:\n- Mostrarte fotos de productos\n- Darte precios\n- Ayudarte a comprar\n- Ver tus pedidos\n\n¿Qué necesitas?',
        accion: 'continuar',
        datos: {}
      };
    }

    // ========== DEFAULT ==========
    return {
      respuesta: 'No entendí bien.\n\n¿Qué necesitas? Puedo mostrarte productos o ayudarte a comprar.',
      accion: 'preguntar',
      datos: {}
    };
  }

  /**
   * Detectar si el usuario quiere hacer un nuevo pedido
   */
  quiereNuevoPedido(msg) {
    const frasesNuevoPedido = [
      'nuevo pedido', 'nueva compra',
      'hacer pedido', 'hacer un pedido', 'realizar pedido', 'realizar un pedido',
      'quiero comprar', 'quiero pedir', 'quiero ordenar',
      'deseo comprar', 'deseo pedir',
      'me interesa comprar', 'quisiera comprar',
      'hacer una compra', 'realizar una compra'
    ];
    
    for (const frase of frasesNuevoPedido) {
      if (msg.includes(frase)) return true;
    }
    
    // Patrones regex
    if (/quiero\s+(hacer|realizar)\s+(un\s+)?(nuevo\s+)?pedido/.test(msg)) return true;
    if (/quisiera\s+(hacer|realizar)\s+(un\s+)?pedido/.test(msg)) return true;
    
    return false;
  }

  /**
   * Detectar si el usuario quiere ver sus pedidos
   */
  quiereVerPedidos(msg) {
    const frasesPedidos = [
      'mis pedidos', 'mi pedido',
      'pedidos tengo', 'pedido tengo',
      'estado de mi pedido', 'estado del pedido', 'estado pedido',
      'ver pedidos', 'ver pedido', 'ver mis pedidos',
      'consultar pedido', 'consultar pedidos',
      'donde está mi pedido', 'donde esta mi pedido',
      'rastrear pedido', 'rastrear',
      'seguimiento', 'tracking',
      'qué pedidos', 'que pedidos',
      'mis compras', 'mi compra'
    ];
    
    for (const frase of frasesPedidos) {
      if (msg.includes(frase)) return true;
    }
    
    // Patrones regex
    if (/qu[eé]\s+pedidos?\s+tengo/.test(msg)) return true;
    if (/tengo\s+pedidos?/.test(msg)) return true;
    if (/mis?\s+pedidos?/.test(msg)) return true;
    
    return false;
  }

  /**
   * Detectar si el usuario quiere ver el catálogo/lista de productos
   */
  quiereVerCatalogo(msg) {
    const palabrasCatalogo = [
      'catálogo', 'catalogo', 
      'productos', 
      'lista', 'listame', 'listar', 'listado',
      'opciones',
      'mostrar todo', 'ver todo', 'todos los',
      'qué tienen', 'que tienen',
      'qué hay', 'que hay',
      'qué venden', 'que venden'
    ];
    
    for (const palabra of palabrasCatalogo) {
      if (msg.includes(palabra)) return true;
    }
    
    if (/qu[eé]\s+tipos/.test(msg)) return true;
    if (/cu[aá]les\s+(tipos|hay|tienen|son)/.test(msg)) return true;
    if (/qu[eé]\s+variedades/.test(msg)) return true;
    if (/qu[eé]\s+modelos/.test(msg)) return true;
    
    if (/^listame$/.test(msg)) return true;
    if (/^lista$/.test(msg)) return true;
    if (/^ver$/.test(msg)) return true;
    
    return false;
  }

  buscarProductoEnMensaje(mensaje, productos) {
    if (!productos || productos.length === 0) return null;
    
    const msgLower = mensaje.toLowerCase();
    
    for (const producto of productos) {
      const nombreLower = producto.nombre.toLowerCase();
      
      if (msgLower.includes(nombreLower)) {
        return producto;
      }
      
      const palabrasProducto = nombreLower.split(/\s+/).filter(p => p.length >= 4);
      for (const palabra of palabrasProducto) {
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
