/**
 * APARTALO CORE - Servicio de IA
 * 
 * Usa Groq (Llama 3.3) como principal y Gemini como backup
 * Para hacer el bot más cálido e inteligente cuando el usuario se pierde
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

  /**
   * Inicializar y verificar conexión
   */
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

    console.log('⚠️ IA: Sin API keys configuradas - usando respuestas locales');
    return false;
  }

  /**
   * Generar respuesta inteligente para mensaje no entendido
   * @param {string} mensaje - Mensaje del usuario
   * @param {object} contexto - Contexto del negocio y productos
   * @returns {object} - { respuesta, accion, datos }
   */
  async procesarMensaje(mensaje, contexto = {}) {
    console.log(`🤖 AI procesarMensaje: "${mensaje}"`);
    console.log(`   initialized: ${this.initialized}, provider: ${this.provider}`);
    
    if (!this.initialized) {
      console.log('   → Usando respuesta local (no inicializado)');
      return this.respuestaLocal(mensaje, contexto);
    }

    try {
      const prompt = this.construirPrompt(mensaje, contexto);
      console.log('   → Llamando a', this.provider);
      
      let resultado;
      if (this.provider === 'groq') {
        resultado = await this.llamarGroq(prompt);
      } else {
        resultado = await this.llamarGemini(prompt);
      }

      if (resultado) {
        console.log(`   → Resultado IA: accion=${resultado.accion}`);
        return resultado;
      }
    } catch (error) {
      console.error('❌ Error IA:', error.message);
    }

    console.log('   → Fallback a respuesta local');
    return this.respuestaLocal(mensaje, contexto);
  }

  /**
   * Construir prompt para la IA
   */
  construirPrompt(mensaje, contexto) {
    const { negocio, productos = [], estadoActual = 'menu' } = contexto;
    
    const productosTexto = productos.slice(0, 10).map(p => 
      `- ${p.nombre}: S/${p.precio} (stock: ${p.disponible || p.stock || 0})`
    ).join('\n');

    return `Eres el asistente de WhatsApp de "${negocio?.nombre || 'la tienda'}".
Tu objetivo es ayudar al cliente de forma CÁLIDA y ÚTIL.

PRODUCTOS DISPONIBLES:
${productosTexto || 'No hay productos cargados'}

ESTADO ACTUAL DEL CLIENTE: ${estadoActual}

REGLAS:
1. Sé amable y usa emojis moderadamente
2. Si preguntan por un producto, búscalo en la lista
3. Si quieren comprar algo, guíalos al catálogo
4. Si no entiendes, pide aclaración amablemente
5. Respuestas cortas (máximo 3 líneas)

ACCIONES DISPONIBLES (responde en JSON):
- ver_catalogo: Mostrar productos
- buscar_producto: Buscar un producto específico {buscar: "término"}
- contactar: Hablar con humano
- continuar: Solo responder, no hacer acción
- menu: Volver al menú principal

MENSAJE DEL CLIENTE: "${mensaje}"

Responde SOLO en este formato JSON:
{
  "respuesta": "texto amable para el cliente",
  "accion": "nombre_accion",
  "datos": {}
}`;
  }

  /**
   * Llamar a Groq API
   */
  async llamarGroq(prompt) {
    console.log('   📡 Llamando Groq API...');
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    console.log(`   📡 Groq response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('   ❌ Groq error:', errorText);
      throw new Error(`Groq error: ${response.status}`);
    }

    const data = await response.json();
    const texto = data.choices?.[0]?.message?.content || '';
    console.log('   📡 Groq respuesta:', texto.substring(0, 100) + '...');
    
    return this.parsearRespuesta(texto);
  }

  /**
   * Llamar a Gemini API
   */
  async llamarGemini(prompt) {
    console.log('   📡 Llamando Gemini API...');
    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300
        }
      })
    });

    console.log(`   📡 Gemini response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`Gemini error: ${response.status}`);
    }

    const data = await response.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('   📡 Gemini respuesta:', texto.substring(0, 100) + '...');
    
    return this.parsearRespuesta(texto);
  }

  /**
   * Parsear respuesta JSON de la IA
   */
  parsearRespuesta(texto) {
    try {
      // Limpiar markdown
      let clean = texto.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      
      // Buscar JSON
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const json = JSON.parse(match[0]);
        console.log('   ✅ JSON parseado:', json.accion);
        return {
          respuesta: json.respuesta || json.mensaje || '',
          accion: json.accion || 'continuar',
          datos: json.datos || {}
        };
      }
    } catch (e) {
      console.log('   ⚠️ No se pudo parsear JSON de IA:', e.message);
    }

    // Si no hay JSON válido, usar el texto como respuesta
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
   * Respuesta local cuando IA no está disponible
   */
  respuestaLocal(mensaje, contexto) {
    const msg = mensaje.toLowerCase().trim();
    const { productos = [] } = contexto;
    
    console.log('   🏠 Generando respuesta local para:', msg);

    // Saludos
    if (/^(hola|buenos|buenas|hey|hi|alo)/.test(msg)) {
      console.log('   → Detectado: saludo');
      return {
        respuesta: '¡Hola! 👋 ¿En qué te puedo ayudar?\n\nPuedes ver nuestro *catálogo* o preguntarme por algún producto.',
        accion: 'continuar',
        datos: {}
      };
    }

    // Preguntas por productos específicos
    if (msg.includes('tienen') || msg.includes('hay') || msg.includes('venden')) {
      console.log('   → Detectado: pregunta por producto');
      // Buscar producto mencionado
      const palabras = msg.split(/\s+/);
      for (const palabra of palabras) {
        if (palabra.length > 3) {
          const encontrado = productos.find(p => 
            p.nombre.toLowerCase().includes(palabra)
          );
          if (encontrado) {
            return {
              respuesta: `¡Sí tenemos! 🎉\n\n*${encontrado.nombre}*\nPrecio: S/${encontrado.precio}\n\n¿Te lo aparto?`,
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

    // Preguntas de precio
    if (msg.includes('cuánto') || msg.includes('cuanto') || msg.includes('precio') || msg.includes('cuesta')) {
      console.log('   → Detectado: pregunta de precio');
      return {
        respuesta: 'Te muestro nuestros productos con precios 💰',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // Quiere comprar
    if (msg.includes('quiero') || msg.includes('necesito') || msg.includes('comprar') || msg.includes('pedir')) {
      console.log('   → Detectado: intención de compra');
      return {
        respuesta: '¡Perfecto! Te muestro lo que tenemos disponible 🛒',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // Regalo / para alguien
    if (msg.includes('regalo') || msg.includes('mamá') || msg.includes('papa') || msg.includes('cumpleaños')) {
      console.log('   → Detectado: regalo');
      return {
        respuesta: '¡Qué lindo detalle! 🎁 Te muestro opciones que podrían gustarte...',
        accion: 'ver_catalogo',
        datos: {}
      };
    }

    // Ayuda
    if (msg.includes('ayuda') || msg.includes('help') || msg.includes('no entiendo') || msg.includes('cómo')) {
      console.log('   → Detectado: ayuda');
      return {
        respuesta: '¡Con gusto te ayudo! 😊\n\nPuedes:\n• Ver el *catálogo*\n• Preguntarme por un producto\n• Escribir *menu* para ver opciones',
        accion: 'continuar',
        datos: {}
      };
    }

    // Contacto humano
    if (msg.includes('hablar') || msg.includes('persona') || msg.includes('humano') || msg.includes('asesor')) {
      console.log('   → Detectado: contacto humano');
      return {
        respuesta: 'Te conecto con alguien del equipo 👤',
        accion: 'contactar',
        datos: {}
      };
    }

    // Agradecimiento
    if (msg.includes('gracias') || msg.includes('thanks')) {
      console.log('   → Detectado: agradecimiento');
      return {
        respuesta: '¡De nada! 😊 ¿Hay algo más en que pueda ayudarte?',
        accion: 'continuar',
        datos: {}
      };
    }

    // Default: no entendió pero amable
    console.log('   → No detectado, respuesta default');
    return {
      respuesta: `Disculpa, no entendí bien 🤔\n\n¿Quieres ver nuestro *catálogo* o prefieres que te ayude con algo específico?`,
      accion: 'continuar',
      datos: {}
    };
  }
}

module.exports = new AIService();
