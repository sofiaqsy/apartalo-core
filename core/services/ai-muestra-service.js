/**
 * APARTALO CORE - AI Muestra Service
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
      console.log('AIMuestraService: GROQ_API_KEY no configurada');
      return false;
    }
    this.initialized = true;
    console.log('✅ AIMuestraService inicializado con GROQ + RAG');
    return true;
  }

  /**
   * @param {string} mensaje - Current user message
   * @param {object} context - Handler context (must include context.from and context.negocio)
   * @param {Array}  historial - Optional chat history array
   * @param {object} datosCliente - Optional pre-fetched client data
   * @param {boolean} yaSePresento - Whether the bot has already introduced itself this session.
   *                                 Use stateManager data, NOT historial.length, to avoid
   *                                 re-introducing when Firestore lags and historial appears empty.
   */
  async procesarMensajeMuestra(mensaje, context, historial = [], datosCliente = null, yaSePresento = false) {
    if (!this.initialized && !this.initialize()) {
      return {
        respuesta: 'El servicio no está disponible en este momento.',
        datosExtraidos: null,
        muestraCompleta: false,
        error: true
      };
    }

    const { negocio } = context;
    const whatsapp = datosCliente?.whatsapp || context.from || null;

    // Use yaSePresento (from stateManager) instead of historial.length to decide
    // whether to include the self-introduction in the prompt.
    // historial.length === 0 was unreliable because Firestore writes from a prior
    // message might not have completed before the next message reads history.
    const esPrimerMensaje = !yaSePresento;

    console.log('🧠 Recuperando memoria del cliente para muestra...');
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(whatsapp, context);
    const systemPrompt = this.construirSystemPromptMuestraConMemoria(negocio, contextoCliente, esPrimerMensaje);
    const messages = this.construirMensajes(systemPrompt, historial, mensaje);

    try {
      const response = await axios.post(this.baseUrl, {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 250,
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
        console.error('JSON detectado en respuesta limpia, aplicando limpieza de emergencia');
        return {
          respuesta: this.limpiezaEmergencia(respuestaLimpia),
          datosExtraidos: datosExtraidos,
          muestraCompleta: datosExtraidos?.muestra_completa === true,
          error: false
        };
      }

      return {
        respuesta: respuestaLimpia,
        datosExtraidos: datosExtraidos,
        muestraCompleta: datosExtraidos?.muestra_completa === true,
        error: false
      };

    } catch (error) {
      console.error('Error en AI Muestra:', error.response?.data || error.message);
      return {
        respuesta: 'Ocurrió un error. Por favor intenta de nuevo.',
        datosExtraidos: null,
        muestraCompleta: false,
        error: true
      };
    }
  }

  construirSystemPromptMuestraConMemoria(negocio, contextoCliente, esPrimerMensaje) {
    const instruccionContacto = esPrimerMensaje
      ? `- Es el primer mensaje: menciona brevemente que eres el asistente virtual de ${negocio.nombre} y que pueden escribir CONTACTAR FINCA si tienen otras consultas.`
      : `- NO te presentes ni repitas que eres asistente. Ya se dijo.\n- Solo menciona CONTACTAR FINCA si el cliente pregunta algo completamente fuera del café o las muestras.`;

    return `Eres el asistente virtual de ${negocio.nombre}, especializado en el programa de muestras gratis de cafe.

CONTEXTO DEL CLIENTE:
${contextoCliente}

ROL Y LIMITES:
- Eres un asistente virtual (bot), no una persona
- Tu objetivo principal: recopilar los datos de entrega para enviar la muestra gratis
- Sin emojis
- Respuestas MUY CORTAS: maxima 2 oraciones. De frente al punto, sin relleno
${instruccionContacto}

SOBRE PREGUNTAS DE PRECIOS O PRODUCTOS:
- Si el cliente pregunta por precios o catalogo: da una respuesta muy breve (1 oracion) mencionando que el cafe es premium de Villa Rica, Peru, y luego pide el dato que falta para la muestra.
- Ejemplo: "Nuestro cafe premium de Villa Rica esta desde S/35/kg. Para enviarte la muestra necesito el nombre de tu negocio."
- Si pregunta sobre un tema completamente ajeno al cafe, responde: "Solo puedo ayudarte con el programa de muestras. Escribe CONTACTAR FINCA para otras consultas."

SOBRE EL PROGRAMA:
- Muestra gratis de 500g para cafeterias y negocios gastronomicos
- Solo 1 muestra por negocio
- Cafe premium de Villa Rica, Peru

DATOS A RECOPILAR:
1. empresa: nombre del negocio o cafeteria
2. nombre_contacto: nombre completo del contacto
3. direccion: direccion con distrito (ej: Av. Larco 123, Miraflores)
4. telefono: 9 digitos

REGLAS:
- Extrae TODOS los datos que el cliente mencione en el mensaje, aunque sea de forma conversacional
- Si ya tiene datos registrados, usalos
- Pregunta solo por lo que falta
- Valida: direccion debe tener distrito, telefono exactamente 9 digitos
- Si el cliente ya dio su nombre y empresa en el mensaje inicial, no los pidas de nuevo

FORMATO - responde en DOS bloques separados por ---DATA---

Bloque 1: mensaje corto para el cliente (solo texto, sin llaves ni corchetes).
---DATA---
Bloque 2: JSON sin backticks.

Ejemplo primer mensaje:
Soy el asistente virtual de ${negocio.nombre}. Para enviarte la muestra de cafe, necesito el nombre de tu negocio y direccion con distrito. Escribe CONTACTAR FINCA si tienes otras consultas.
---DATA---
{"intent":"solicitar_muestra","empresa":null,"nombre_contacto":null,"direccion":null,"telefono":null,"muestra_completa":false,"datos_faltantes":["empresa","nombre_contacto","direccion","telefono"]}

Ejemplo respuesta normal:
Perfecto. Cual es la direccion con distrito de Cafe Gourmet?
---DATA---
{"intent":"solicitar_muestra","empresa":"Cafe Gourmet","nombre_contacto":"Maria","direccion":null,"telefono":null,"muestra_completa":false,"datos_faltantes":["direccion","telefono"]}`;
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
      const jsonConBackticks = respuesta.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonConBackticks && jsonConBackticks[1]) return JSON.parse(jsonConBackticks[1]);
      const jsonMatch = respuesta.match(/\{[\s\S]*"muestra_completa"[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
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
    limpia = limpia.replace(/\{[\s\S]*?"muestra_completa"[\s\S]*?\}/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"intent"[\s\S]*?\}/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"datos_faltantes"[\s\S]*?\}/g, '');
    return limpia.trim();
  }

  tieneJSONExpuesto(respuesta) {
    return (
      respuesta.includes('"intent"') ||
      respuesta.includes('"muestra_completa"') ||
      respuesta.includes('"datos_faltantes"') ||
      respuesta.includes('"nombre_contacto"') ||
      /\{\s*"[a-z_]+"/.test(respuesta)
    );
  }

  limpiezaEmergencia(respuesta) {
    const indiceJson = respuesta.search(/\{[\s\S]*"[a-z_]+"/);
    if (indiceJson > 0) return respuesta.substring(0, indiceJson).trim();
    return 'Gracias por la informacion. En breve te contactamos para coordinar el envio.';
  }
}

module.exports = new AIMuestraService();
