/**
 * APARTALO CORE - AI Order Service
 * 
 * Servicio de IA conversacional para toma de pedidos.
 * Usa el contexto del negocio (productos, reglas, tono) para
 * mantener una conversacion natural y extraer datos del pedido.
 * 
 * CARACTERISTICAS:
 * - Carga prompt dinamico desde Configuracion del negocio
 * - Incluye productos actuales del Inventario
 * - Extrae datos estructurados (producto, cantidad, datos cliente)
 * - Mantiene historial de conversacion
 */

const Anthropic = require('@anthropic-ai/sdk');

class AIOrderService {
  constructor() {
    this.client = null;
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return true;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('AIOrderService: ANTHROPIC_API_KEY no configurada');
      return false;
    }

    try {
      this.client = new Anthropic({ apiKey });
      this.initialized = true;
      console.log('AIOrderService inicializado');
      return true;
    } catch (error) {
      console.error('Error inicializando AIOrderService:', error.message);
      return false;
    }
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
    const messages = this.construirMensajes(historial, mensaje);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages
      });

      const respuestaTexto = response.content[0].text;
      
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
      console.error('Error en AI:', error.message);
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
    const productosTexto = productos.map(p => 
      `- ${p.nombre} (${p.codigo}): S/${p.precio} ${p.descripcion ? '- ' + p.descripcion : ''}`
    ).join('\n');

    const clienteTexto = datosCliente 
      ? `\nDATOS CONOCIDOS DEL CLIENTE:\n- Nombre: ${datosCliente.nombre || 'No registrado'}\n- Direccion: ${datosCliente.direccion || 'No registrada'}\n- Telefono: ${datosCliente.telefono || 'No registrado'}`
      : '\nCLIENTE NUEVO: No tenemos datos registrados.';

    return `Eres el asistente de ventas de ${negocio.nombre}. Tu trabajo es ayudar a los clientes a hacer pedidos de manera conversacional y natural.

SOBRE EL NEGOCIO:
${config.prompt_negocio || 'Somos un negocio dedicado a ofrecer productos de calidad.'}

REGLAS DE VENTA:
${config.reglas_venta || 'Consultar disponibilidad y precios.'}

INFORMACION ADICIONAL:
${config.info_adicional || ''}

TONO DE COMUNICACION:
${config.tono || 'Amable y profesional'}

PRODUCTOS DISPONIBLES:
${productosTexto || 'Consultar catalogo'}
${clienteTexto}

INSTRUCCIONES:
1. Responde de manera natural y conversacional, como un vendedor humano
2. No uses emojis
3. Guia al cliente para obtener: producto, cantidad, direccion de entrega, nombre y telefono
4. Si el cliente pregunta por productos, describe las opciones disponibles
5. Si el cliente indica un producto, confirma y pregunta la cantidad
6. Si ya tienes producto y cantidad, solicita datos de entrega (si no los tienes)
7. Cuando tengas TODOS los datos, confirma el pedido completo

IMPORTANTE - Al final de CADA respuesta, incluye un bloque JSON con los datos extraidos:
\`\`\`json
{
  "intent": "consulta|pedido|otro",
  "producto_codigo": "CODIGO o null",
  "producto_nombre": "nombre o null", 
  "cantidad": numero o null,
  "nombre_cliente": "nombre o null",
  "direccion": "direccion o null",
  "telefono": "telefono o null",
  "pedido_completo": true/false,
  "datos_faltantes": ["lista", "de", "datos", "faltantes"]
}
\`\`\`

El JSON debe reflejar TODOS los datos que tienes hasta el momento (de mensajes anteriores + mensaje actual).`;
  }

  /**
   * Construir array de mensajes para la API
   */
  construirMensajes(historial, mensajeActual) {
    const messages = [];

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
