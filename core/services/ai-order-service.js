/**
 * APARTALO CORE - AI Order Service v5.8
 * 
 * v5.8: Filtro de seguridad de temas, respuestas cortas, identidad de bot
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
      console.log('AIOrderService: GROQ_API_KEY no configurada');
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

    const systemPrompt = this.construirSystemPrompt(negocio, contextoCliente);
    const messages = this.construirMensajes(systemPrompt, historial, mensaje);

    try {
      const response = await axios.post(this.baseUrl, {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 300,
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

      if (this.tieneJSONExpuesto(respuestaLimpia)) {
        console.log('JSON expuesto detectado, aplicando limpieza de emergencia');
        return {
          respuesta: this.limpiezaEmergencia(respuestaLimpia),
          datosExtraidos: datosExtraidos,
          pedidoCompleto: datosExtraidos?.pedido_completo === true,
          error: false
        };
      }

      return {
        respuesta: respuestaLimpia,
        datosExtraidos: datosExtraidos,
        pedidoCompleto: datosExtraidos?.pedido_completo === true,
        error: false
      };

    } catch (error) {
      console.error('Error en AI:', error.response?.data || error.message);
      return {
        respuesta: 'Ocurrio un error. Por favor intenta de nuevo.',
        datosExtraidos: null,
        pedidoCompleto: false,
        error: true
      };
    }
  }

  construirSystemPrompt(negocio, contextoCliente) {
    return `Eres el asistente virtual de ${negocio.nombre}, productores de cafe premium de Villa Rica, Peru.

CONTEXTO DEL CLIENTE:
${contextoCliente}

═══════════════════════════════════════
LIMITES DE TEMA - MUY IMPORTANTE
═══════════════════════════════════════
Solo puedes hablar de:
- Productos y precios de ${negocio.nombre}
- Como hacer un pedido
- Estado de pedidos del cliente
- Informacion sobre el cafe de Villa Rica
- Coordinar entregas

Si el cliente pregunta algo FUERA de estos temas (politica, religion, otros negocios, recetas, consejos personales, etc.), responde exactamente:
"Solo puedo ayudarte con informacion sobre nuestro cafe y pedidos. Para otras consultas, escribe CONTACTAR FINCA."

═══════════════════════════════════════
IDENTIDAD
═══════════════════════════════════════
- Eres un asistente virtual, no una persona
- En el PRIMER mensaje (historial vacio): presentate en UNA linea y menciona CONTACTAR FINCA
- En mensajes siguientes: NO te presentes de nuevo, ve directo al punto
- Si el cliente tiene dudas o quiere hablar con alguien: "Escribe CONTACTAR FINCA"

═══════════════════════════════════════
ESTILO DE RESPUESTA
═══════════════════════════════════════
- Maximo 2 oraciones por respuesta
- Sin saludos repetidos
- Sin relleno ("claro que si", "con gusto", "por supuesto")
- Directo al dato o la pregunta
- Sin emojis

EJEMPLOS CORRECTOS:
Cliente: "hola" → "Soy el asistente virtual de ${negocio.nombre}. Puedo ayudarte con productos, precios y pedidos, o escribe CONTACTAR FINCA para hablar con el equipo."
Cliente: "que cafes tienen" → "Tenemos [productos del catalogo]. ¿Cual te interesa?"
Cliente: "cuanto cuesta el kilo" → "El cafe en grano esta a S/[precio] el kg."
Cliente: "me puedes dar una receta" → "Solo puedo ayudarte con informacion sobre nuestro cafe y pedidos. Para otras consultas, escribe CONTACTAR FINCA."

═══════════════════════════════════════
PRODUCTOS
═══════════════════════════════════════
- SOLO usa productos del CATALOGO del contexto
- SOLO usa precios del CATALOGO
- Si el producto no esta en catalogo: "No tenemos ese producto disponible."
- Pedidos multiples: extrae todos los productos en el array

FORMATO DE RESPUESTA - separa con ---DATA---

Mensaje para el cliente (maximo 2 oraciones, sin llaves).
---DATA---
{"intent":"consulta|pedido|otro","productos":[{"codigo":"...","nombre":"...","cantidad":0,"precio":0}],"total_calculado":0,"nombre_cliente":null,"direccion":null,"telefono":null,"pedido_completo":false,"datos_faltantes":[]}
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
      if (respuesta.includes('---DATA---')) {
        const partes = respuesta.split('---DATA---');
        if (partes[1]) {
          return JSON.parse(partes[1].trim());
        }
      }

      const jsonMatch = respuesta.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        return JSON.parse(jsonMatch[1]);
      }

      const jsonRaw = respuesta.match(/\{[\s\S]*?"pedido_completo"[\s\S]*?\}/);
      if (jsonRaw) {
        return JSON.parse(jsonRaw[0]);
      }
    } catch (error) {
      console.log('Error parseando JSON de respuesta:', error.message);
    }
    return null;
  }

  limpiarRespuesta(respuesta) {
    let limpia = respuesta;

    if (limpia.includes('---DATA---')) {
      limpia = limpia.split('---DATA---')[0];
    }

    limpia = limpia.replace(/```json[\s\S]*?```/g, '');
    limpia = limpia.replace(/```[\s\S]*?```/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"pedido_completo"[\s\S]*?\}/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"intent"[\s\S]*?\}/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"datos_faltantes"[\s\S]*?\}/g, '');

    return limpia.trim();
  }

  tieneJSONExpuesto(respuesta) {
    return (
      respuesta.includes('"intent"') ||
      respuesta.includes('"pedido_completo"') ||
      respuesta.includes('"datos_faltantes"') ||
      respuesta.includes('"producto_codigo"') ||
      /\{\s*"[a-z_]+"/.test(respuesta)
    );
  }

  limpiezaEmergencia(respuesta) {
    const indiceJson = respuesta.search(/\{[\s\S]*"[a-z_]+"/);
    if (indiceJson > 0) {
      return respuesta.substring(0, indiceJson).trim();
    }
    return 'En que te puedo ayudar?';
  }
}

module.exports = new AIOrderService();
