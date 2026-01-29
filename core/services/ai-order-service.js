/**
 * APARTALO CORE - AI Order Service v5.3 - SOLO USA CONTEXTO REAL
 * 
 * Servicio de IA conversacional para toma de pedidos.
 * Usa GROQ (Llama) para procesamiento rapido y economico.
 * 
 * v5.3: CRÍTICO - NO inventar productos ni precios, SOLO usar catálogo real
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
   * Construir prompt del sistema CON memoria simulada - NO INVASIVO + NO INVENTAR
   */
  construirSystemPromptConMemoria(negocio, contextoCliente) {
    return `Eres el asistente de ventas de ${negocio.nombre}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL CLIENTE (USA ESTA INFO SILENCIOSAMENTE):
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ REGLAS CRÍTICAS - NO INVENTAR INFORMACIÓN:

1. SOLO USA productos que están en el CATÁLOGO arriba
2. SOLO USA precios que aparecen en el CATÁLOGO
3. Si el cliente pide un producto que NO está en el catálogo, di "No tenemos ese producto. Te puedo mostrar lo que tenemos disponible"
4. Si NO hay métodos de pago en el contexto, NO menciones métodos de pago
5. NUNCA inventes códigos de producto, precios, o información
6. Si no tienes información sobre algo, admítelo

REGLAS DE PRIVACIDAD:
1. NUNCA menciones que tienes acceso a su historial
2. NUNCA digas "ya hablamos antes" o "la última vez"
3. USA la información silenciosamente para ser útil

CÓMO IDENTIFICAR PRODUCTOS:
- Lee el CATÁLOGO en el contexto
- Busca el CÓDIGO exacto (ej: CAT-001, CAFE-GRANO)
- USA el precio que aparece en el catálogo
- Si tiene [ESPECIAL], es precio personalizado

EJEMPLOS:

❌ MAL: "Café molido a S/50 por kilo"
✅ BIEN: Primero verificar si "café molido" está en el catálogo. Si NO está, decir "No tenemos café molido disponible. Tenemos café en grano a S/70/kg"

❌ MAL: "¿Deseas pagar con tarjeta o efectivo?"
✅ BIEN: Si NO hay métodos de pago en el contexto, NO mencionarlos. Pedir solo los datos de entrega.

INSTRUCCIONES:
1. Respuestas BREVES (máximo 2 líneas)
2. NO inventes información
3. Si no sabes, admítelo
4. Si ya saludaste, NO saludes otra vez
5. Ve directo al punto
6. NO uses emojis

IMPORTANTE: Al final incluye JSON:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "producto_codigo": "CODIGO_EXACTO del catálogo o null",
  "producto_nombre": "nombre EXACTO del catálogo o null", 
  "cantidad": numero o null,
  "precio_unitario": numero EXACTO del catálogo o null,
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
