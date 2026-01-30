/**
 * APARTALO CORE - AI Order Service v5.6 - MULTI-PRODUCT SUPPORT
 * 
 * v5.6: Support extracting multiple products in one order
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
3. **MULTI-PRODUCT ORDERS SUPPORTED**: Customer can order multiple products at once
4. When asked about product characteristics/details:
   - ALWAYS mention the full DESCRIPTION from the catalog
   - Include variety, origin, quality details
   - Extract product_codigo so the image gets sent
5. If product not in catalog: "No tenemos ese producto. Te puedo mostrar lo que tenemos disponible"
6. NEVER invent product codes, prices, or information
7. If you don't have information: admit it

PRIVACY RULES:
1. NEVER mention you have access to their history
2. NEVER say "ya hablamos antes" or "la última vez"
3. USE information silently to be helpful

HOW TO IDENTIFY PRODUCTS:
- Read the CATALOG in the context
- Find the EXACT CODE (e.g., CAT-001, CAT-002)
- USE the price from the catalog
- If it has [ESPECIAL], it's a personalized price
- READ the full DESCRIPTION and share it when asked

WHEN CUSTOMER ORDERS MULTIPLE PRODUCTS:
✅ GOOD: "Perfecto. 5kg de café en grano (S/350) y 3 bolsas de molido (S/45). Total: S/395"
✅ Extract BOTH products in the productos array

WHEN CUSTOMER ASKS ABOUT CHARACTERISTICS:
- Share ALL details from the Description field
- Mention variety, origin, quality
- Include the product_codigo in your JSON response so image gets sent

EXAMPLES:

Customer: "Quiero 5kg de café en grano y 3 bolsas de molido"
✅ GOOD Response: "Perfecto. 5kg de café en grano (S/350) y 3 bolsas de molido (S/45). Total: S/395. ¿Confirmas?"
✅ Extract: productos: [{codigo: "CAT-001", cantidad: 5, precio: 70}, {codigo: "CAT-002", cantidad: 3, precio: 15}]

INSTRUCTIONS:
1. Brief responses (max 2-3 lines)
2. DO NOT invent information
3. MULTIPLE PRODUCTS ARE SUPPORTED - extract all of them
4. If you already greeted, DON'T greet again
5. Get to the point
6. NO emojis

IMPORTANT: Always include JSON at the end:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "productos": [
    {
      "codigo": "EXACT CODE from catalog",
      "nombre": "EXACT name from catalog",
      "cantidad": number,
      "precio": number (unit price)
    }
  ],
  "total_calculado": number,
  "nombre_cliente": "name or null",
  "direccion": "address or null",
  "telefono": "phone or null",
  "pedido_completo": true/false,
  "datos_faltantes": ["list"]
}
\`\`\`

LEGACY SUPPORT: If you only extract ONE product, you can also use:
- producto_codigo
- producto_nombre
- cantidad
- precio_unitario
`;
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
