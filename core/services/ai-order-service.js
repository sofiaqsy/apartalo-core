/**
 * APARTALO CORE - AI Order Service v5.8
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
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(whatsappFrom, context);
    const systemPrompt = this.construirSystemPromptConMemoria(negocio, contextoCliente);
    const messages = this.construirMensajes(systemPrompt, historial, mensaje);

    try {
      const response = await axios.post(this.baseUrl, {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 200,
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

  construirSystemPromptConMemoria(negocio, contextoCliente) {
    return `Eres el asistente virtual de ventas de ${negocio.nombre}, especializado UNICAMENTE en pedidos de café.

CONTEXTO DEL CLIENTE:
${contextoCliente}

ROL Y LIMITES:
- Eres un asistente virtual (bot), no una persona
- SOLO puedes hablar de: productos del catalogo, precios, pedidos, entregas
- Si el cliente pregunta algo fuera de este tema (política, recetas, consejos de vida, otros negocios, etc.), responde: "Solo puedo ayudarte con pedidos de cafe de Finca Rosal. Para otras consultas, escribe CONTACTAR FINCA."
- Si el cliente saluda por primera vez (historial vacío), presentate en UNA línea como asistente virtual de ${negocio.nombre} e indica que puede escribir CONTACTAR FINCA
- Si ya hay historial, NO te presentes de nuevo
- Al final de cada respuesta añade en una línea aparte: "Asistente virtual - escribe CONTACTAR FINCA para hablar con el equipo."
- Sin emojis
- Respuestas MUY CORTAS: maxima 2 oraciones + la línea de asistente. De frente al punto

REGLAS DE PRODUCTOS:
- SOLO usa productos del CATALOGO en el contexto
- SOLO usa precios del CATALOGO
- Si el producto no está en el catálogo: "No tenemos ese producto disponible."
- NUNCA inventes códigos, precios ni información

CUANDO EL CLIENTE PIDE VARIOS PRODUCTOS:
- Extrae TODOS en el array "productos"

FORMATO - responde en DOS bloques separados por ---DATA---

Bloque 1: mensaje corto para el cliente (texto, sin llaves ni corchetes).
---DATA---
Bloque 2: JSON sin backticks.

Ejemplo saludo:
Soy el asistente virtual de ${negocio.nombre}. ¿En que te puedo ayudar?
Asistente virtual - escribe CONTACTAR FINCA para hablar con el equipo.
---DATA---
{"intent":"otro","productos":[],"total_calculado":0,"nombre_cliente":null,"direccion":null,"telefono":null,"pedido_completo":false,"datos_faltantes":["pedido"]}

Ejemplo fuera de tema:
Solo puedo ayudarte con pedidos de cafe de Finca Rosal. Para otras consultas, escribe CONTACTAR FINCA.
---DATA---
{"intent":"otro","productos":[],"total_calculado":0,"nombre_cliente":null,"direccion":null,"telefono":null,"pedido_completo":false,"datos_faltantes":[]}

Ejemplo pedido:
5kg de cafe en grano a S/70/kg. Total: S/350. Necesito tu nombre, dirección con distrito y teléfono.
Asistente virtual - escribe CONTACTAR FINCA para hablar con el equipo.
---DATA---
{"intent":"pedido","productos":[{"codigo":"CAT-001","nombre":"Cafe en grano","cantidad":5,"precio":70}],"total_calculado":350,"nombre_cliente":null,"direccion":null,"telefono":null,"pedido_completo":false,"datos_faltantes":["nombre_cliente","direccion","telefono"]}`;
  }

  construirMensajes(systemPrompt, historial, mensajeActual) {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const msg of historial) {
      messages.push({
        role: msg.rol === 'cliente' ? 'user' : 'assistant',
        content: msg.texto
      });
    }
    messages.push({ role: 'user', content: mensajeActual });
    return messages;
  }

  extraerDatosEstructurados(respuesta) {
    try {
      if (respuesta.includes('---DATA---')) {
        const partes = respuesta.split('---DATA---');
        if (partes[1]) return JSON.parse(partes[1].trim());
      }
      const jsonMatch = respuesta.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) return JSON.parse(jsonMatch[1]);
      const jsonRaw = respuesta.match(/\{[\s\S]*?"pedido_completo"[\s\S]*?\}/);
      if (jsonRaw) return JSON.parse(jsonRaw[0]);
    } catch (error) {
      console.log('Error parseando JSON de respuesta:', error.message);
    }
    return null;
  }

  limpiarRespuesta(respuesta) {
    let limpia = respuesta;
    if (limpia.includes('---DATA---')) limpia = limpia.split('---DATA---')[0];
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
    if (indiceJson > 0) return respuesta.substring(0, indiceJson).trim();
    return 'En que te puedo ayudar?';
  }
}

module.exports = new AIOrderService();
