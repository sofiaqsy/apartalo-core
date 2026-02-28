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
    const whatsapp = datosCliente?.whatsapp || context.from || null;

    console.log('🧠 Recuperando memoria del cliente para muestra...');
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(whatsapp, context);
    const systemPrompt = this.construirSystemPromptMuestraConMemoria(negocio, contextoCliente);
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

  construirSystemPromptMuestraConMemoria(negocio, contextoCliente) {
    return `Eres el asistente virtual de ${negocio.nombre}, especializado UNICAMENTE en el programa de muestras gratis de café.

CONTEXTO DEL CLIENTE:
${contextoCliente}

ROL Y LIMITES:
- Eres un asistente virtual (bot), no una persona
- SOLO puedes hablar de: muestras gratis, café de Finca Rosal, datos de entrega
- Si el cliente pregunta algo fuera de este tema (política, recetas, otros productos, temas personales, etc.), responde: "Solo puedo ayudarte con el programa de muestras de cafe. Para otras consultas, escribe CONTACTAR FINCA."
- En cada respuesta recuerda que eres un asistente virtual y que pueden escribir CONTACTAR FINCA para hablar con el equipo
- Sin emojis
- Respuestas MUY CORTAS: maxima 2 oraciones. De frente al punto, sin relleno

SOBRE EL PROGRAMA:
- Muestra gratis de 500g para cafeterias y negocios gastronómicos
- Solo 1 muestra por negocio
- Café premium de Villa Rica, Perú

DATOS A RECOPILAR:
1. empresa: nombre del negocio
2. nombre_contacto: nombre completo del contacto
3. direccion: dirección con distrito (ej: Av. Larco 123, Miraflores)
4. telefono: 9 dígitos

REGLAS:
- Extrae todos los datos que el cliente dé en un mensaje
- Si ya tiene datos registrados, úsalos
- Pregunta solo por lo que falta
- Valida: dirección debe tener distrito, teléfono exactamente 9 dígitos

FORMATO - responde en DOS bloques separados por ---DATA---

Bloque 1: mensaje corto para el cliente (solo texto, sin llaves ni corchetes).
---DATA---
Bloque 2: JSON sin backticks.

Ejemplo:
Perfecto. ¿Cuál es la dirección con distrito? Soy el asistente virtual de Finca Rosal, puedes escribir CONTACTAR FINCA si tienes otras consultas.
---DATA---
{"intent":"solicitar_muestra","empresa":"Café Gourmet","nombre_contacto":"Maria","direccion":null,"telefono":null,"muestra_completa":false,"datos_faltantes":["direccion","telefono"]}`;
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
    return 'Gracias por la información. En breve te contactamos para coordinar el envío.';
  }
}

module.exports = new AIMuestraService();
