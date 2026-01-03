/**
 * APARTALO CORE - AI Order Service v2
 * 
 * Servicio de IA conversacional para toma de pedidos.
 * Usa GROQ (Llama) para procesamiento rapido y economico.
 * 
 * CARACTERISTICAS:
 * - Carga prompt dinamico desde Configuracion del negocio
 * - Incluye productos actuales del Inventario con formato claro
 * - Extrae datos estructurados (producto, cantidad, datos cliente)
 * - Mantiene historial de conversacion
 */

const axios = require('axios');

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
    console.log('AIOrderService inicializado con GROQ');
    return true;
  }

  /**
   * Procesar mensaje del cliente en flujo de pedido
   */
  async procesarMensajePedido(mensaje, context, historial = [], datosCliente = null) {
    if (!this.initialized && !this.initialize()) {
      return {
        respuesta: 'El servicio no esta disponible en este momento.',
        datosExtraidos: null,
        pedidoCompleto: false,
        error: true
      };
    }

    const { sheets, negocio } = context;

    // Cargar contexto del negocio
    const [configuracion, productos] = await Promise.all([
      this.cargarConfiguracion(sheets),
      this.cargarProductos(sheets)
    ]);

    // Construir prompt del sistema
    const systemPrompt = this.construirSystemPrompt(negocio, configuracion, productos, datosCliente);

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
      console.error('Error en AI:', error.response?.data || error.message);
      return {
        respuesta: 'Ocurrio un error. Por favor intenta de nuevo.',
        datosExtraidos: null,
        pedidoCompleto: false,
        error: true
      };
    }
  }

  /**
   * Cargar configuracion del negocio desde Sheets
   */
  async cargarConfiguracion(sheets) {
    try {
      const config = await sheets.getConfiguracion();
      return {
        prompt_negocio: config.prompt_negocio || '',
        reglas_venta: config.reglas_venta || '',
        tono: config.tono || 'amable y profesional',
        info_adicional: config.info_adicional || '',
        horario: config.horario || '',
        departamento: config.departamento || 'Lima'
      };
    } catch (error) {
      console.log('Error cargando configuracion:', error.message);
      return {};
    }
  }

  /**
   * Cargar productos del inventario
   */
  async cargarProductos(sheets) {
    try {
      const productos = await sheets.getProductos('ACTIVO');
      return productos.map(p => ({
        codigo: p.codigo,
        nombre: p.nombre,
        descripcion: p.descripcion || '',
        precio: p.precio,
        stock: p.disponible || p.stock
      }));
    } catch (error) {
      console.log('Error cargando productos:', error.message);
      return [];
    }
  }

  /**
   * Construir prompt del sistema con contexto del negocio
   */
  construirSystemPrompt(negocio, config, productos, datosCliente) {
    // Formato de productos mas claro y estructurado
    const productosTexto = productos.map(p => 
      'CODIGO: ' + p.codigo + '\n' +
      '  Nombre: ' + p.nombre + '\n' +
      '  Precio: S/' + p.precio + '\n' +
      (p.descripcion ? '  Descripcion: ' + p.descripcion + '\n' : '')
    ).join('\n');

    const clienteTexto = datosCliente 
      ? '\nDATOS CONOCIDOS DEL CLIENTE:\n- Nombre: ' + (datosCliente.nombre || 'No registrado') + '\n- Direccion: ' + (datosCliente.direccion || 'No registrada') + '\n- Telefono: ' + (datosCliente.telefono || 'No registrado')
      : '\nCLIENTE NUEVO: No tenemos datos registrados.';

    return `Eres el asistente de ventas de ${negocio.nombre}. Tu trabajo es ayudar a los clientes a hacer pedidos.

SOBRE EL NEGOCIO:
${config.prompt_negocio || 'Somos un negocio dedicado a ofrecer productos de calidad.'}

REGLAS DE VENTA IMPORTANTES:
${config.reglas_venta || 'Consultar disponibilidad y precios.'}

INFORMACION ADICIONAL:
${config.info_adicional || ''}

CATALOGO DE PRODUCTOS (USA ESTOS CODIGOS Y PRECIOS EXACTOS):
${productosTexto || 'Consultar catalogo'}
${clienteTexto}

INSTRUCCIONES CRITICAS:
1. SIEMPRE usa el CODIGO exacto del producto del catalogo
2. SIEMPRE usa el PRECIO exacto del catalogo para calcular totales
3. Responde de manera natural y conversacional
4. NO uses emojis
5. Si el cliente pide "cafe en grano" o "cafe por kilo" sin especificar, pregunta cual producto del catalogo desea
6. Guia al cliente: producto -> cantidad -> datos de entrega
7. Respuestas cortas, maximo 3-4 lineas

CALCULO DE TOTALES:
- Busca el producto en el catalogo
- Multiplica: precio_unitario x cantidad = total
- Ejemplo: Si CAF-001 cuesta S/70 y piden 8kg, total = 70 x 8 = S/560

IMPORTANTE - Al final de CADA respuesta, incluye un bloque JSON:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "producto_codigo": "CODIGO_EXACTO_DEL_CATALOGO o null",
  "producto_nombre": "nombre exacto o null", 
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
      console.log('Error parseando JSON de respuesta:', error.message);
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
