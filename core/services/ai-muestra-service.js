/**
 * APARTALO CORE - AI Muestra Service CON MEMORIA SIMULADA
 * 
 * Servicio de IA conversacional para flujo de muestras gratis.
 * Usa GROQ (Llama) para procesamiento natural y conversacional.
 * 
 * CARACTERÍSTICAS CON MEMORIA:
 * - Recupera información completa del cliente (Clientes, Pedidos, etc.)
 * - "Recuerda" si el cliente ya compró antes
 * - Personaliza la conversación basándose en el historial
 * - Conversación natural (no interrogatorio paso a paso)
 * - Extrae múltiples datos de un solo mensaje
 * - Valida datos (teléfono 9 dígitos, dirección con distrito)
 */

const axios = require('axios');
const clienteContextService = require('./cliente-context-service');

class AIMuestraService {
  constructor() {
    this.apiKey = null;
    this.initialized = false;
    this.baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
  }

  initialize() {
    if (this.initialized) return true;

    this.apiKey = process.env.GROQ_API_KEY;
    if (!this.apiKey) {
      console.log('⚠️ AIMuestraService: GROQ_API_KEY no configurada');
      return false;
    }

    this.initialized = true;
    console.log('✅ AIMuestraService inicializado con GROQ + RAG');
    return true;
  }

  /**
   * Procesar mensaje del cliente en flujo de muestra gratis CON MEMORIA
   */
  async procesarMensajeMuestra(mensaje, context, historial = [], datosCliente = null) {
    if (!this.initialized && !this.initialize()) {
      return {
        respuesta: 'El servicio no está disponible en este momento.',
        datosExtraidos: null,
        muestraCompleta: false,
        error: true
      };
    }

    const { negocio } = context;

    // 🧠 NUEVO: Obtener contexto completo del cliente (MEMORIA SIMULADA)
    // Extraer whatsapp del datosCliente
    const whatsapp = datosCliente?.whatsapp || context.from || null;
    
    console.log('🧠 Recuperando memoria del cliente para muestra...');
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(
      whatsapp, 
      context
    );

    // Construir prompt del sistema con memoria
    const systemPrompt = this.construirSystemPromptMuestraConMemoria(
      negocio, 
      contextoCliente
    );

    // Construir mensajes
    const messages = this.construirMensajes(systemPrompt, historial, mensaje);

    try {
      const response = await axios.post(this.baseUrl, {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 512,
        temperature: 0.6
      }, {
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const respuestaTexto = response.data.choices[0].message.content;
      
      // Extraer JSON estructurado
      const datosExtraidos = this.extraerDatosEstructurados(respuestaTexto);
      
      // Limpiar respuesta (quitar JSON)
      const respuestaLimpia = this.limpiarRespuesta(respuestaTexto);

      return {
        respuesta: respuestaLimpia,
        datosExtraidos: datosExtraidos,
        muestraCompleta: datosExtraidos?.muestra_completa === true,
        error: false
      };

    } catch (error) {
      console.error('❌ Error en AI Muestra:', error.response?.data || error.message);
      return {
        respuesta: 'Ocurrió un error. Por favor intenta de nuevo.',
        datosExtraidos: null,
        muestraCompleta: false,
        error: true
      };
    }
  }

  /**
   * Construir prompt del sistema para muestras CON memoria
   */
  construirSystemPromptMuestraConMemoria(negocio, contextoCliente) {
    return `Eres el asistente de ${negocio.nombre} para el programa de MUESTRAS GRATIS de café.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL CLIENTE (Usa esta info para personalizar):
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SOBRE EL PROGRAMA DE MUESTRAS:
- Ofrecemos muestras GRATIS de 500g a cafeterías y negocios gastronómicos
- Es para probar la calidad antes de comprar al por mayor
- Solo 1 muestra por negocio (política estricta)
- Somos productores de café premium de Villa Rica, Perú

TU ROL:
- Habla de forma natural, cálida y profesional
- NO uses emojis
- Si el cliente YA compró antes, menciona que conoce nuestro café
- Si tiene datos registrados, úsalos para agilizar el proceso
- Explica brevemente el beneficio de la muestra
- Recopila datos de forma conversacional (no interrogatorio)

DATOS NECESARIOS:
1. **Nombre del negocio/cafetería** (campo: empresa)
2. **Nombre completo del contacto** (campo: nombre_contacto)
3. **Dirección completa de entrega** - DEBE incluir distrito (campo: direccion)
4. **Teléfono de contacto** - 9 dígitos (campo: telefono)

REGLAS DE CONVERSACIÓN:
- Si el cliente da varios datos en un solo mensaje, extráelos todos
- Si ya tiene datos en el sistema, úsalos (pero confirma siempre)
- Si falta algún dato, pregunta solo por lo que falta
- Sé flexible: el cliente puede dar los datos en cualquier orden
- Valida que la dirección incluya distrito (Lima, Miraflores, San Isidro, etc.)
- Valida que el teléfono tenga 9 dígitos
- Si el cliente pregunta algo sobre el café, responde brevemente

PERSONALIZACIÓN SEGÚN HISTORIAL:
- Si el cliente ya compró: "Qué bueno que quieras probar más de nuestro café antes de tu próximo pedido"
- Si es cliente nuevo: "Perfecto para conocer la calidad de nuestro café de Villa Rica"
- Si tiene empresa registrada: Úsala como sugerencia

IMPORTANTE - Al final de CADA respuesta, incluye un bloque JSON:
\`\`\`json
{
  "intent": "solicitar_muestra|consulta|otro",
  "empresa": "nombre del negocio o null",
  "nombre_contacto": "nombre completo o null",
  "direccion": "dirección completa con distrito o null",
  "telefono": "teléfono de 9 dígitos o null",
  "muestra_completa": true/false,
  "datos_faltantes": ["lista", "de", "campos", "faltantes"]
}
\`\`\`

VALIDACIONES:
- direccion debe incluir distrito (ej: "Av. Larco 123, Miraflores")
- telefono debe tener exactamente 9 dígitos (sin espacios ni guiones)
- muestra_completa debe ser true SOLO si tienes los 4 campos completos Y válidos

EJEMPLOS:

Cliente nuevo:
Msg: "Soy María de Café Gourmet"
Resp: "Hola María, qué bueno que Café Gourmet quiera probar nuestro café de Villa Rica. Para enviarte la muestra de 500g, necesito tu dirección completa con distrito y un teléfono de contacto."

Cliente con historial:
Msg: "Quiero una muestra"
Resp: "Perfecto! Veo que ya nos conoces, la última vez pediste 5kg de nuestro blend. Te enviaremos 500g de muestra a tu dirección registrada en Jr. Lima 123, Cercado de Lima. Solo confirma tu teléfono de contacto."

Datos completos:
Msg: "Jr. Ucayali 345, Cercado de Lima, teléfono 998877665"
Resp: "Excelente María, ya tenemos todo. Te enviaremos 500g de nuestro café premium de Villa Rica a Jr. Ucayali 345, Cercado de Lima. Te contactaremos pronto para coordinar la entrega."`;
  }

  /**
   * Construir array de mensajes para la API
   */
  construirMensajes(systemPrompt, historial, mensajeActual) {
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Agregar historial
    for (const msg of historial) {
      messages.push({
        role: msg.rol === 'cliente' ? 'user' : 'assistant',
        content: msg.texto
      });
    }

    // Agregar mensaje actual
    messages.push({
      role: 'user',
      content: mensajeActual
    });

    return messages;
  }

  /**
   * Extraer datos estructurados del JSON en la respuesta
   */
  extraerDatosEstructurados(respuesta) {
    try {
      const jsonMatch = respuesta.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        return JSON.parse(jsonMatch[1]);
      }
    } catch (error) {
      console.log('⚠️ Error parseando JSON de respuesta:', error.message);
    }
    return null;
  }

  /**
   * Limpiar respuesta quitando el bloque JSON
   */
  limpiarRespuesta(respuesta) {
    return respuesta
      .replace(/```json\s*[\s\S]*?\s*```/g, '')
      .trim();
  }
}

module.exports = new AIMuestraService();
