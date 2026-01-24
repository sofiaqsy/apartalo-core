/**
 * APARTALO CORE - AI Muestra Service
 * 
 * Servicio de IA conversacional para flujo de muestras gratis.
 * Usa GROQ (Llama) para procesamiento natural y conversacional.
 * 
 * CARACTERÍSTICAS:
 * - Conversación natural (no interrogatorio paso a paso)
 * - Extrae múltiples datos de un solo mensaje
 * - Valida datos (teléfono 9 dígitos, dirección con distrito)
 * - Reutiliza datos del cliente registrado
 */

const axios = require('axios');

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
    console.log('✅ AIMuestraService inicializado');
    return true;
  }

  /**
   * Procesar mensaje del cliente en flujo de muestra gratis
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

    // Construir prompt del sistema
    const systemPrompt = this.construirSystemPromptMuestra(negocio, datosCliente);

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
   * Construir prompt del sistema para muestras
   */
  construirSystemPromptMuestra(negocio, datosCliente) {
    const clienteTexto = datosCliente 
      ? `\nDATOS DEL CLIENTE REGISTRADO:\n- Nombre: ${datosCliente.nombre || 'No registrado'}\n- Empresa: ${datosCliente.empresa || 'No registrada'}\n- Dirección: ${datosCliente.direccion || 'No registrada'}\n- Teléfono: ${datosCliente.telefono || 'No registrado'}`
      : '\nCLIENTE NUEVO: No tenemos datos previos.';

    return `Eres el asistente de ${negocio.nombre} para el programa de MUESTRAS GRATIS de café.

CONTEXTO DEL NEGOCIO:
- Somos productores de café premium de Villa Rica, Perú
- Ofrecemos muestras GRATIS de 500g a cafeterías y negocios gastronómicos
- Es para probar la calidad antes de comprar al por mayor
- Solo 1 muestra por negocio (no se puede solicitar más de una)

TU ROL:
- Habla de forma natural, cálida y profesional
- NO uses emojis
- Explica brevemente el beneficio de la muestra (conocer calidad, probar antes de comprar)
- Recopila datos de forma conversacional (no interrogatorio)

DATOS NECESARIOS:
1. **Nombre del negocio/cafetería** (campo: empresa)
2. **Nombre completo del contacto** (campo: nombre_contacto)
3. **Dirección completa de entrega** - DEBE incluir distrito (campo: direccion)
4. **Teléfono de contacto** - 9 dígitos (campo: telefono)

REGLAS DE CONVERSACIÓN:
- Si el cliente da varios datos en un solo mensaje, extráelos todos
- Si falta algún dato, pregunta solo por lo que falta
- Sé flexible: el cliente puede dar los datos en cualquier orden
- Valida que la dirección incluya distrito (Lima, Miraflores, San Isidro, etc.)
- Valida que el teléfono tenga 9 dígitos
- Si el cliente pregunta algo sobre el café, responde brevemente y vuelve a pedir datos${clienteTexto}

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
- Si el cliente da un teléfono con menos de 9 dígitos, pide que lo corrija
- muestra_completa debe ser true SOLO si tienes los 4 campos completos Y válidos

EJEMPLOS DE RESPUESTAS:

Ejemplo 1 (datos parciales):
Cliente: "Soy María de Café Gourmet"
Tu respuesta: "Hola María, qué bueno que Café Gourmet quiera probar nuestro café de Villa Rica. Para enviarte la muestra de 500g, necesito tu dirección completa con distrito y un teléfono de contacto."

Ejemplo 2 (casi completo, falta distrito):
Cliente: "Mi dirección es Jr. Ucayali 345 y mi teléfono es 998877665"
Tu respuesta: "Perfecto. Solo para confirmar, en qué distrito está Jr. Ucayali 345?"

Ejemplo 3 (teléfono inválido):
Cliente: "Mi teléfono es 12345678"
Tu respuesta: "El teléfono que me diste tiene 8 dígitos. Por favor proporciona un número de 9 dígitos."

Ejemplo 4 (completo):
Cliente: "Jr. Ucayali 345, Cercado de Lima, teléfono 998877665"
Tu respuesta: "Excelente María, ya tenemos todo registrado. Te enviaremos 500g de nuestro café premium de Villa Rica a Jr. Ucayali 345, Cercado de Lima. Te contactaremos pronto para coordinar la entrega."`;
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
