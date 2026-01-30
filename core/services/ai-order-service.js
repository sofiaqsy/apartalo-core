/**
 * APARTALO CORE - AI Order Service v5.4 - Product Details Support
 * 
 * v5.4: When customer asks for product details/characteristics, provide description + trigger image
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

    console.log('🧠 Recuperando memoria del cliente...');
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(
      whatsappFrom, 
      context
    );

    const systemPrompt = this.construirSystemPromptConMemoria(
      negocio, 
      contextoCliente
    );

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
      const datosExtraidos = this.extraerDatosEstructurados(respuestaTexto);
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

  construirSystemPromptConMemoria(negocio, contextoCliente) {
    return `You are the sales assistant for ${negocio.nombre}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLIENT CONTEXT (USE THIS INFO SILENTLY):
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ CRITICAL RULES - DO NOT INVENT INFORMATION:

1. ONLY use products from the CATALOG above
2. ONLY use prices from the CATALOG
3. When asked about product characteristics/details:
   - ALWAYS mention the full DESCRIPTION from the catalog
   - Include variety, origin, quality details
   - Extract product_codigo so the image gets sent
4. If product not in catalog: "No tenemos ese producto. Te puedo mostrar lo que tenemos disponible"
5. If no payment methods in context: DO NOT mention payment methods
6. NEVER invent product codes, prices, or information
7. If you don't have information: admit it

PRIVACY RULES:
1. NEVER mention you have access to their history
2. NEVER say "ya hablamos antes" or "la última vez"
3. USE information silently to be helpful

HOW TO IDENTIFY PRODUCTS:
- Read the CATALOG in the context
- Find the EXACT CODE (e.g., CAT-001, CAFE-GRANO)
- USE the price from the catalog
- If it has [ESPECIAL], it's a personalized price
- READ the full DESCRIPTION and share it when asked

WHEN CUSTOMER ASKS ABOUT CHARACTERISTICS:
- Share ALL details from the Description field
- Mention variety, origin, quality
- Include the product_codigo in your JSON response so image gets sent

EXAMPLES:

❌ BAD: "Nuestro café es de alta calidad. No tengo más detalles"
✅ GOOD: "Es un Blend de típico, caturra y pache. Variedad: Arábica. Café de altura 1600 msnm, proceso lavado, tostado claro"

❌ BAD: "Café molido a S/50 por kilo"
✅ GOOD: Check catalog first. If not available: "No tenemos café molido disponible. Tenemos café en grano a S/70/kg"

INSTRUCTIONS:
1. Brief responses (max 2-3 lines)
2. DO NOT invent information
3. If you don't know, admit it
4. If you already greeted, DON'T greet again
5. Get to the point
6. NO emojis

IMPORTANT: Always include JSON at the end:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "producto_codigo": "EXACT CODE from catalog or null",
  "producto_nombre": "EXACT name from catalog or null", 
  "cantidad": number or null,
  "precio_unitario": EXACT number from catalog or null,
  "total_calculado": number or null,
  "nombre_cliente": "name or null",
  "direccion": "address or null",
  "telefono": "phone or null",
  "pedido_completo": true/false,
  "datos_faltantes": ["list"]
}
\`\`\``;
  }

  construirMensajes(systemPrompt, historial, mensajeActual) {
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    for (const msg of historial) {
      messages.push({
        role: msg.rol === 'cliente' ? 'user' : 'assistant',
        content: msg.texto
      });
    }

    messages.push({
      role: 'user',
      content: mensajeActual
    });

    return messages;
  }

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

  limpiarRespuesta(respuesta) {
    return respuesta
      .replace(/```json\s*[\s\S]*?\s*```/g, '')
      .trim();
  }
}

module.exports = new AIOrderService();
