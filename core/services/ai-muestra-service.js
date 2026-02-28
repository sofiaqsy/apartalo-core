/**
 * APARTALO CORE - AI Muestra Service CON MEMORIA SIMULADA
 * 
 * Servicio de IA conversacional para flujo de muestras gratis.
 * Usa GROQ (Llama) para procesamiento natural y conversacional.
 * 
 * CARACTERÍSTICAS CON MEMORIA:
 * - Recupera información completa del cliente (Clientes, Pedidos, etc.)
 * - "Recuerda" si el cliente ya compró antes
 * - Personaliza la conversación basándose en el historial
 * - Conversación natural (no interrogatorio paso a paso)
 * - Extrae múltiples datos de un solo mensaje
 * - Valida datos (teléfono 9 dígitos, dirección con distrito)
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
      console.log('⚠️ AIMuestraService: GROQ_API_KEY no configurada');
      return false;
    }

    this.initialized = true;
    console.log('✅ AIMuestraService inicializado con GROQ + RAG');
    return true;
  }

  /**
   * Procesar mensaje del cliente en flujo de muestra gratis CON MEMORIA
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

    const whatsapp = datosCliente?.whatsapp || context.from || null;
    
    console.log('🧠 Recuperando memoria del cliente para muestra...');
    const contextoCliente = await clienteContextService.obtenerContextoCompleto(
      whatsapp, 
      context
    );

    const systemPrompt = this.construirSystemPromptMuestraConMemoria(
      negocio, 
      contextoCliente
    );

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
      
      // Extraer datos estructurados del JSON (antes de limpiar)
      const datosExtraidos = this.extraerDatosEstructurados(respuestaTexto);
      
      // Limpiar respuesta eliminando CUALQUIER forma de JSON
      const respuestaLimpia = this.limpiarRespuesta(respuestaTexto);

      // Validar que la respuesta limpia no tenga JSON expuesto
      if (this.tieneJSONExpuesto(respuestaLimpia)) {
        console.error('⚠️ JSON detectado en respuesta limpia, aplicando limpieza de emergencia');
        const respuestaEmergencia = this.limpiezaEmergencia(respuestaLimpia);
        return {
          respuesta: respuestaEmergencia,
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
   * Construir prompt del sistema para muestras CON memoria
   */
  construirSystemPromptMuestraConMemoria(negocio, contextoCliente) {
    return `Eres el asistente de ${negocio.nombre} para el programa de MUESTRAS GRATIS de café.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL CLIENTE (Usa esta info para personalizar):
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SOBRE EL PROGRAMA DE MUESTRAS:
- Ofrecemos muestras GRATIS de 500g a cafeterías y negocios gastronómicos
- Es para probar la calidad antes de comprar al por mayor
- Solo 1 muestra por negocio (política estricta)
- Somos productores de café premium de Villa Rica, Perú

TU ROL:
- Habla de forma natural, cálida y profesional
- NO uses emojis
- Si el cliente YA compró antes, menciona que conoce nuestro café
- Si tiene datos registrados, úsalos para agilizar el proceso
- Explica brevemente el beneficio de la muestra
- Recopila datos de forma conversacional (no interrogatorio)

DATOS NECESARIOS:
1. Nombre del negocio/cafetería (campo: empresa)
2. Nombre completo del contacto (campo: nombre_contacto)
3. Dirección completa de entrega - DEBE incluir distrito (campo: direccion)
4. Teléfono de contacto - 9 dígitos (campo: telefono)

REGLAS DE CONVERSACIÓN:
- Si el cliente da varios datos en un solo mensaje, extráelos todos
- Si ya tiene datos en el sistema, úsalos (pero confirma siempre)
- Si falta algún dato, pregunta solo por lo que falta
- Sé flexible: el cliente puede dar los datos en cualquier orden
- Valida que la dirección incluya distrito (Lima, Miraflores, San Isidro, etc.)
- Valida que el teléfono tenga 9 dígitos
- Si el cliente pregunta algo sobre el café, responde brevemente

PERSONALIZACIÓN SEGÚN HISTORIAL:
- Si el cliente ya compró: "Qué bueno que quieras probar más de nuestro café antes de tu próximo pedido"
- Si es cliente nuevo: "Perfecto para conocer la calidad de nuestro café de Villa Rica"
- Si tiene empresa registrada: Úsala como sugerencia

FORMATO DE RESPUESTA - MUY IMPORTANTE:
Responde en DOS bloques separados por ---DATA---

Bloque 1: El mensaje conversacional para el cliente (solo texto natural, sin llaves ni corchetes).
---DATA---
Bloque 2: Solo el JSON con los datos, sin backticks ni markdown.

Ejemplo:
Hola María, qué bueno que Café Gourmet quiera probar nuestro café. Para enviarte la muestra de 500g, ¿cuál es tu dirección con distrito?
---DATA---
{"intent":"solicitar_muestra","empresa":"Café Gourmet","nombre_contacto":"María","direccion":null,"telefono":null,"muestra_completa":false,"datos_faltantes":["direccion","telefono"]}

VALIDACIONES:
- direccion debe incluir distrito (ej: "Av. Larco 123, Miraflores")
- telefono debe tener exactamente 9 dígitos (sin espacios ni guiones)
- muestra_completa debe ser true SOLO si tienes los 4 campos completos Y válidos`;
  }

  /**
   * Construir array de mensajes para la API
   */
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

  /**
   * Extraer datos estructurados - soporta múltiples formatos de respuesta
   */
  extraerDatosEstructurados(respuesta) {
    try {
      // Formato nuevo: separador ---DATA---
      if (respuesta.includes('---DATA---')) {
        const partes = respuesta.split('---DATA---');
        if (partes[1]) {
          return JSON.parse(partes[1].trim());
        }
      }

      // Formato legacy con backticks: ```json ... ```
      const jsonConBackticks = respuesta.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonConBackticks && jsonConBackticks[1]) {
        return JSON.parse(jsonConBackticks[1]);
      }

      // Formato legacy sin backticks: buscar objeto JSON al final
      const jsonMatch = respuesta.match(/\{[\s\S]*"muestra_completa"[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.log('⚠️ Error parseando JSON de respuesta:', error.message);
    }
    return null;
  }

  /**
   * Limpiar respuesta - elimina el bloque de datos del mensaje al cliente
   */
  limpiarRespuesta(respuesta) {
    let limpia = respuesta;

    // Eliminar formato nuevo con separador
    if (limpia.includes('---DATA---')) {
      limpia = limpia.split('---DATA---')[0];
    }

    // Eliminar bloques ```json ... ```
    limpia = limpia.replace(/```json[\s\S]*?```/g, '');

    // Eliminar bloques ``` ... ``` genéricos
    limpia = limpia.replace(/```[\s\S]*?```/g, '');

    // Eliminar objetos JSON crudos que contengan campos del formulario
    limpia = limpia.replace(/\{[\s\S]*?"muestra_completa"[\s\S]*?\}/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"intent"[\s\S]*?\}/g, '');
    limpia = limpia.replace(/\{[\s\S]*?"datos_faltantes"[\s\S]*?\}/g, '');

    return limpia.trim();
  }

  /**
   * Verificar si la respuesta limpia todavía contiene JSON expuesto
   */
  tieneJSONExpuesto(respuesta) {
    return (
      respuesta.includes('"intent"') ||
      respuesta.includes('"muestra_completa"') ||
      respuesta.includes('"datos_faltantes"') ||
      respuesta.includes('"nombre_contacto"') ||
      /\{\s*"[a-z_]+"/.test(respuesta)
    );
  }

  /**
   * Limpieza de emergencia: quitar todo a partir del primer { que parezca JSON
   */
  limpiezaEmergencia(respuesta) {
    const indiceJson = respuesta.search(/\{[\s\S]*"[a-z_]+"/);
    if (indiceJson > 0) {
      return respuesta.substring(0, indiceJson).trim();
    }
    // Si todo es JSON, devolver mensaje genérico
    return 'Gracias por la información. En breve te contactamos para coordinar el envío.';
  }
}

module.exports = new AIMuestraService();
