/**
 * APARTALO CORE - AI Order Service v5 CON MEMORIA SIMULADA
 * 
 * Servicio de IA conversacional para toma de pedidos.
 * Usa GROQ (Llama) para procesamiento rapido y economico.
 * 
 * NUEVAS CARACTERÍSTICAS v5:
 * - Memoria simulada (RAG) - Recupera contexto completo del cliente
 * - Información de todas las hojas: Clientes, Pedidos, PreciosClientes, Inventario, Configuracion
 * - IA "recuerda" preferencias, pedidos anteriores y precios personalizados
 * 
 * CARACTERÍSTICAS ANTERIORES:
 * - Precios personalizados por cliente (PreciosClientes)
 * - IA puede mencionar precios correctos en la conversacion
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
        max_tokens: 1024,
        temperature: 0.5
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
   * Construir prompt del sistema CON memoria simulada
   * El contexto del cliente ya incluye:
   * - Datos del cliente (Clientes)
   * - Precios personalizados (PreciosClientes)
   * - Historial de pedidos (Pedidos)
   * - Productos disponibles (Inventario)
   * - Configuración del negocio (Configuracion)
   * - Últimas conversaciones (Firestore)
   */
  construirSystemPromptConMemoria(negocio, contextoCliente) {
    return `Eres el asistente de ventas conversacional de ${negocio.nombre}.

Tu trabajo es ayudar a los clientes a hacer pedidos de forma natural y personalizada.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPORTANTE: A continuación tienes TODA la información del cliente:
${contextoCliente}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INSTRUCCIONES DE CONVERSACIÓN:
1. Responde de manera natural, cálida y conversacional
2. NO uses emojis
3. USA la información del contexto para personalizar tus respuestas:
   - Si el cliente ya compró antes, menciona sus preferencias
   - Si tiene precios especiales, menciónalo como beneficio
   - Si hay conversación previa, da continuidad
4. Sé proactivo: sugiere productos basándote en su historial
5. Calcula totales usando los precios del catálogo (incluye precios especiales)
6. Respuestas cortas (máximo 3-4 líneas)
7. Obtén: producto (código), cantidad, datos de entrega

EJEMPLOS DE PERSONALIZACIÓN:

Cliente nuevo:
"Hola! Bienvenido a ${negocio.nombre}. Tenemos café premium de Villa Rica. ¿Qué producto te interesa?"

Cliente con historial:
"Hola María! La última vez pediste 5kg de nuestro blend y te encantó. ¿Quieres más de ese o prefieres probar algo diferente?"

Cliente con precio especial:
"Perfecto! Como cliente frecuente tienes precio especial: S/65 por kilo en lugar de S/70. ¿Cuántos kilos quieres?"

IMPORTANTE - Al final de CADA respuesta, incluye un bloque JSON:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "producto_codigo": "CODIGO_DEL_CATALOGO o null",
  "producto_nombre": "nombre del producto o null", 
  "cantidad": numero o null,
  "precio_unitario": numero o null,
  "total_calculado": numero o null,
  "nombre_cliente": "nombre o null",
  "direccion": "direccion o null",
  "telefono": "telefono o null",
  "pedido_completo": true/false,
  "datos_faltantes": ["lista", "de", "datos", "faltantes"]
}
\`\`\`

REGLAS PARA IDENTIFICAR PRODUCTOS:
- Si piden "cafe en grano" o "cafe por kilo" o "blend", buscar en el catálogo
- Usa el CÓDIGO exacto del catálogo
- Si hay precio especial, úsalo (ya está en el catálogo)

El JSON debe tener los datos acumulados de toda la conversacion.`;
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
