/**
 * APARTALO CORE - AI Order Service v4
 * 
 * Servicio de IA conversacional para toma de pedidos.
 * Usa GROQ (Llama) para procesamiento rapido y economico.
 * 
 * CARACTERISTICAS:
 * - Carga productos con precios personalizados por cliente
 * - Precios vienen de PreciosClientes o Inventario
 * - IA puede mencionar precios correctos en la conversacion
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
  async procesarMensajePedido(mensaje, context, historial = [], datosCliente = null, whatsappFrom = null) {
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
      this.cargarProductosConPrecios(sheets, whatsappFrom)
    ]);

    // Construir prompt del sistema con precios personalizados
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
   * Cargar productos CON precios personalizados para el cliente
   */
  async cargarProductosConPrecios(sheets, whatsappFrom) {
    try {
      if (whatsappFrom) {
        // Usar precios personalizados del cliente
        return await sheets.getProductosConPrecios(whatsappFrom);
      } else {
        // Sin cliente, usar precios de lista
        return await sheets.getProductos('ACTIVO');
      }
    } catch (error) {
      console.log('Error cargando productos:', error.message);
      return [];
    }
  }

  /**
   * Construir prompt del sistema con precios personalizados
   */
  construirSystemPrompt(negocio, config, productos, datosCliente) {
    // Lista de productos CON precios
    const productosTexto = productos.map(p => {
      let linea = '- ' + p.codigo + ': ' + p.nombre + ' - S/' + p.precio;
      if (p.descripcion) {
        linea += ' (' + p.descripcion + ')';
      }
      if (p.tieneDescuento) {
        linea += ' [PRECIO ESPECIAL]';
      }
      return linea;
    }).join('\n');

    const clienteTexto = datosCliente 
      ? '\nDATOS CONOCIDOS DEL CLIENTE:\n- Nombre: ' + (datosCliente.nombre || 'No registrado') + '\n- Direccion: ' + (datosCliente.direccion || 'No registrada') + '\n- Telefono: ' + (datosCliente.telefono || 'No registrado')
      : '\nCLIENTE NUEVO: No tenemos datos registrados.';

    return `Eres el asistente de ventas de ${negocio.nombre}. Tu trabajo es ayudar a los clientes a hacer pedidos de forma conversacional.

SOBRE EL NEGOCIO:
${config.prompt_negocio || 'Somos un negocio dedicado a ofrecer productos de calidad.'}

REGLAS DE VENTA:
${config.reglas_venta || 'Consultar disponibilidad.'}

INFORMACION ADICIONAL:
${config.info_adicional || ''}

CATALOGO DE PRODUCTOS CON PRECIOS PARA ESTE CLIENTE:
${productosTexto || 'Consultar catalogo'}
${clienteTexto}

INSTRUCCIONES:
1. Responde de manera natural y conversacional
2. NO uses emojis
3. USA los precios del catalogo de arriba para calcular totales
4. Guia al cliente para obtener: producto (codigo), cantidad, datos de entrega
5. Si el cliente pregunta por productos, menciona las opciones CON sus precios
6. Si el cliente pide un producto, identifica el CODIGO correcto y calcula el total
7. Respuestas cortas, maximo 3-4 lineas

CALCULO DE TOTALES:
- Usa el precio del catalogo x cantidad
- Ejemplo: Si CAF-001 cuesta S/70 y piden 8kg, total = S/560

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
- Si piden "cafe en grano" o "cafe por kilo" o "blend", usar CAF-001
- Si piden "cafe molido 250g" o "bolsa molido", usar CAF-002  
- Si piden "cafe en grano 250g" o "bolsa grano", usar CAF-003
- Siempre usar el CODIGO exacto del catalogo

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
