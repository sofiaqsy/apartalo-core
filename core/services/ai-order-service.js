/**
 * APARTALO CORE - AI Order Service v5.7
 * 
 * v5.7: Saludo identifica al bot, proteccion contra JSON expuesto
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

    const systemPrompt = this.construirSystemPromptConMemoria(negocio, contextoCliente);
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

      // Guardia final: si aun queda JSON expuesto, cortar antes de la primera llave
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

  construirSystemPromptConMemoria(negocio, contextoCliente) {
    return `Eres el asistente virtual de ventas de ${negocio.nombre}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL CLIENTE (usa esta info en silencio):
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REGLAS CRITICAS:
1. Eres un asistente virtual (bot), no una persona
2. Si el cliente saluda por primera vez, preséntate brevemente como asistente virtual de ${negocio.nombre} e indica que puede escribir CONTACTAR FINCA si desea hablar con el equipo directamente
3. Si ya hay historial de conversacion, NO te presentes de nuevo ni saludes otra vez
4. SOLO usa productos del CATALOGO del contexto
5. SOLO usa precios del CATALOGO
6. Si el producto no está en el catálogo: "No tenemos ese producto disponible"
7. NUNCA inventes códigos, precios ni información
8. NO uses emojis

REGLAS DE PRIVACIDAD:
1. NUNCA menciones que tienes acceso a su historial
2. NUNCA digas "ya hablamos antes" o "la última vez"
3. USA la información del contexto en silencio para ser útil

PEDIDOS MULTIPLES:
- El cliente puede pedir varios productos en un mensaje
- Extrae TODOS los productos en el array "productos"

CUANDO PREGUNTEN POR CARACTERISTICAS:
- Comparte todos los detalles del campo Descripcion del catalogo
- Incluye el product_codigo en el JSON para que se envie la imagen

INSTRUCCIONES DE RESPUESTA:
- Respuestas cortas (max 2-3 lineas)
- Ve al punto directamente
- Sin emojis

FORMATO - responde en DOS bloques separados por ---DATA---

Bloque 1: mensaje conversacional para el cliente (solo texto, sin llaves ni corchetes).
---DATA---
Bloque 2: JSON con los datos, sin backticks.

Ejemplo saludo:
Buenos dias, soy el asistente virtual de ${negocio.nombre}. Puedo ayudarte con informacion de productos y pedidos. Si prefieres hablar con el equipo, escribe CONTACTAR FINCA.
---DATA---
{"intent":"otro","productos":[],"total_calculado":0,"nombre_cliente":null,"direccion":null,"telefono":null,"pedido_completo":false,"datos_faltantes":["pedido"]}

Ejemplo pedido:
Perfecto. 5kg de cafe en grano a S/70 el kg. Total: S/350. Para confirmar necesito tu nombre, direccion con distrito y telefono.
---DATA---
{"intent":"pedido","productos":[{"codigo":"CAT-001","nombre":"Cafe en grano","cantidad":5,"precio":70}],"total_calculado":350,"nombre_cliente":null,"direccion":null,"telefono":null,"pedido_completo":false,"datos_faltantes":["nombre_cliente","direccion","telefono"]}
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
      // Formato nuevo: separador ---DATA---
      if (respuesta.includes('---DATA---')) {
        const partes = respuesta.split('---DATA---');
        if (partes[1]) {
          return JSON.parse(partes[1].trim());
        }
      }

      // Formato legacy con backticks
      const jsonMatch = respuesta.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        return JSON.parse(jsonMatch[1]);
      }

      // Formato legacy sin backticks: buscar objeto JSON con campos conocidos
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

    // Eliminar separador nuevo
    if (limpia.includes('---DATA---')) {
      limpia = limpia.split('---DATA---')[0];
    }

    // Eliminar bloques ```json ... ```
    limpia = limpia.replace(/```json[\s\S]*?```/g, '');
    limpia = limpia.replace(/```[\s\S]*?```/g, '');

    // Eliminar JSON crudo con campos conocidos del pedido
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
