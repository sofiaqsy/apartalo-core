/**
 * APARTALO CORE - AI Order Service v5.2 CON MEMORIA SIMULADA + NO INVASIVO
 * 
 * Servicio de IA conversacional para toma de pedidos.
 * Usa GROQ (Llama) para procesamiento rapido y economico.
 * 
 * v5.2: Usa memoria sin ser invasivo - NO menciona "ya hablamos antes"
 */

const axios = require('axios');
const clienteContextService = require('./cliente-context-service');

class AIOrderService {
  constructor() {
    this.apiKey = null;
    this.initialized = false;
    this.baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
  }

  initialize() {
    if (this.initialized) return true;

    this.apiKey = process.env.GROQ_API_KEY;
    if (!this.apiKey) {
      console.log('⚠️ AIOrderService: GROQ_API_KEY no configurada');
      return false;
    }

    this.initialized = true;
    console.log('✅ AIOrderService inicializado con GROQ + RAG');
    return true;
  }

  /**
   * Procesar mensaje del cliente en flujo de pedido CON MEMORIA SIMULADA
   */
  async procesarMensajePedido(mensaje, context, historial = [], datosCliente = null, whatsappFrom = null) {
    if (!this.initialized && !this.initialize()) {
      return {
        respuesta: 'El servicio no esta disponible en este momento.',
        datosExtraidos: null,
        pedidoCompleto: false,
        error: true
      };
    }

    const { negocio } = context;

    // 🧠 NUEVO: Obtener contexto completo del cliente (MEMORIA SIMULADA)
    console.log('🧠 Recuperando memoria del cliente...');
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(
      whatsappFrom, 
      context
    );

    // Construir prompt del sistema CON contexto enriquecido
    const systemPrompt = this.construirSystemPromptConMemoria(
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
        temperature: 0.3
      }, {
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const respuestaTexto = response.data.choices[0].message.content;
      
      // Extraer JSON estructurado si existe
      const datosExtraidos = this.extraerDatosEstructurados(respuestaTexto);
      
      // Limpiar respuesta (quitar JSON si lo hay)
      const respuestaLimpia = this.limpiarRespuesta(respuestaTexto);

      return {
        respuesta: respuestaLimpia,
        datosExtraidos: datosExtraidos,
        pedidoCompleto: datosExtraidos?.pedido_completo === true,
        error: false
      };

    } catch (error) {
      console.error('❌ Error en AI:', error.response?.data || error.message);
      return {
        respuesta: 'Ocurrio un error. Por favor intenta de nuevo.',
        datosExtraidos: null,
        pedidoCompleto: false,
        error: true
      };
    }
  }

  /**
   * Construir prompt del sistema CON memoria simulada - NO INVASIVO
   */
  construirSystemPromptConMemoria(negocio, contextoCliente) {
    return `Eres el asistente de ventas de ${negocio.nombre}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL CLIENTE (USA ESTA INFO SILENCIOSAMENTE):
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REGLAS CRÍTICAS - PRIVACIDAD Y NATURALIDAD:

1. NUNCA menciones que tienes acceso a su historial
2. NUNCA digas "ya hablamos antes" o "la última vez"
3. USA la información silenciosamente para ser útil
4. Si el cliente pide café en grano y tú sabes que siempre pide 5kg, SUGIERE esa cantidad naturalmente sin mencionar historial

CÓMO USAR EL CONTEXTO SIN SER INVASIVO:

❌ MAL: "Ya hablamos anteriormente sobre café en grano"
✅ BIEN: "¿Quieres café en grano? ¿Cuántos kilos?"

❌ MAL: "La última vez pediste 5kg"
✅ BIEN: "¿Quieres 5kg como siempre o una cantidad diferente?"

❌ MAL: "Veo que tu dirección es..."
✅ BIEN: "¿La dirección de entrega es la misma?"

INSTRUCCIONES:
1. Respuestas BREVES (máximo 2 líneas)
2. NO menciones el historial explícitamente
3. Si ya saludaste, NO saludes otra vez
4. Ve directo al punto
5. NO uses emojis
6. Si tienen datos guardados, úsalos sin mencionar cómo los obtuviste

EJEMPLOS:

Cliente nuevo:
"Bienvenido. ¿Qué producto te interesa?"

Cliente que ya te conoce:
"¿Café en grano? ¿Cuántos kilos quieres?"

Cliente con precio especial (NO digas "tienes precio especial"):
"Café en grano a S/65 por kilo. ¿Cuántos kilos?"

Cliente con dirección guardada:
"¿Envío a la dirección que tenemos registrada?"

IMPORTANTE: Al final incluye JSON:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "producto_codigo": "CODIGO o null",
  "producto_nombre": "nombre o null", 
  "cantidad": numero o null,
  "precio_unitario": numero o null,
  "total_calculado": numero o null,
  "nombre_cliente": "nombre o null",
  "direccion": "direccion o null",
  "telefono": "telefono o null",
  "pedido_completo": true/false,
  "datos_faltantes": ["lista"]
}
\`\`\``;
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

module.exports = new AIOrderService();
