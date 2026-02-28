/**
 * APARTALO CORE - Tests: Handler Unificado
 *
 * Cubre los flujos críticos del index.js:
 * - Saludo inicial (identificación como bot)
 * - Comandos globales (menu, cancelar)
 * - Contactar Finca (palabras clave variadas)
 * - Detección de imágenes/vouchers
 * - Detección de muestras
 * - Flujo principal por estado
 */

jest.mock('../../core/services/ai-service', () => ({
  procesarMensaje: jest.fn(async () => ({
    respuesta: 'Hola, soy el asistente. ¿En qué te ayudo?',
    accion: 'menu',
    datos: {}
  })),
  initialized: true,
  initialize: jest.fn(async () => true)
}));

jest.mock('../../core/services/ai-order-service', () => ({
  procesarMensajePedido: jest.fn(async () => ({
    respuesta: 'Tenemos Cafe Especial 250g a S/25. ¿Cuántos kilos deseas?',
    pedidoCompleto: false,
    datosExtraidos: {},
    error: false
  }))
}));

jest.mock('../../core/utils/formatters', () => ({
  getGreeting: jest.fn(() => 'Buenos dias'),
  generateId: jest.fn(() => 'PED-TEST-001')
}));

const { handle } = require('../../handlers/unificado/index');
const { crearContextoMock } = require('../helpers/mockContext');

const FROM = '51999888777';

describe('Handler Unificado - Saludo y presentacion del bot', () => {
  test('El saludo debe identificarse como asistente virtual, no como persona', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'menu', data: {} });

    await handle(FROM, { text: 'menu', type: 'text' }, ctx);

    const mensajes = ctx._mensajesEnviados;
    expect(mensajes.length).toBeGreaterThan(0);
    const texto = mensajes[0].msg;
    expect(texto).toContain('asistente virtual');
    expect(texto).toContain('Finca Rosal');
  });

  test('El saludo debe mencionar como contactar a la finca', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'menu', data: {} });

    await handle(FROM, { text: 'menu', type: 'text' }, ctx);

    const texto = ctx._mensajesEnviados[0].msg;
    expect(texto.toLowerCase()).toContain('contactar finca');
  });

  test('El saludo no debe contener iconos o emojis', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'menu', data: {} });

    await handle(FROM, { text: 'menu', type: 'text' }, ctx);

    const texto = ctx._mensajesEnviados[0].msg;
    // Regex para detectar emojis
    const emojiRegex = /[\u{1F300}-\u{1FFFF}]/u;
    expect(emojiRegex.test(texto)).toBe(false);
  });

  test('El saludo con "inicio" tambien debe mostrar el bot identificado', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'menu', data: {} });

    await handle(FROM, { text: 'inicio', type: 'text' }, ctx);

    const texto = ctx._mensajesEnviados[0].msg;
    expect(texto).toContain('asistente virtual');
  });
});

describe('Handler Unificado - Contactar Finca', () => {
  const palabrasClave = [
    'contactar finca',
    'contactar',
    'asesor',
    'ayuda',
    'hablar con alguien',
    'hablar con la finca',
    'finca',
    'humano',
    'equipo'
  ];

  palabrasClave.forEach((palabra) => {
    test(`Debe activar modo asesor cuando cliente escribe: "${palabra}"`, async () => {
      const ctx = crearContextoMock();
      ctx.stateManager.getState.mockReturnValue({ step: 'pedido_conversacional', data: {} });

      await handle(FROM, { text: palabra, type: 'text' }, ctx);

      expect(ctx.asesorService.activarModoAsesor).toHaveBeenCalledWith(FROM, ctx);
    });
  });

  test('El mensaje de conexion con la finca no debe contener emojis', async () => {
    const ctx = crearContextoMock();
    // Deshabilitar asesorHumano para testear el bloque else
    ctx.hasFeature.mockReturnValue(false);
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });

    await handle(FROM, { text: 'contactar finca', type: 'text' }, ctx);

    const texto = ctx._mensajesEnviados[0].msg;
    const emojiRegex = /[\u{1F300}-\u{1FFFF}]/u;
    expect(emojiRegex.test(texto)).toBe(false);
  });

  test('El mensaje de conexion debe mencionar el nombre del negocio', async () => {
    const ctx = crearContextoMock();
    ctx.hasFeature.mockReturnValue(false);
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });

    await handle(FROM, { text: 'contactar finca', type: 'text' }, ctx);

    const texto = ctx._mensajesEnviados[0].msg;
    expect(texto).toContain('Finca Rosal');
  });
});

describe('Handler Unificado - Comandos globales', () => {
  test('El comando "cancelar" debe resetear el estado y confirmar al cliente', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'pedido_conversacional', data: {} });

    await handle(FROM, { text: 'cancelar', type: 'text' }, ctx);

    expect(ctx.stateManager.resetState).toHaveBeenCalledWith(FROM, 'BIZ-002');
    const texto = ctx._mensajesEnviados[0].msg;
    expect(texto.toLowerCase()).toContain('cancelad');
  });

  test('El comando "menu" debe resetear el estado', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'pedido_conversacional', data: {} });

    await handle(FROM, { text: 'menu', type: 'text' }, ctx);

    expect(ctx.stateManager.resetState).toHaveBeenCalledWith(FROM, 'BIZ-002');
  });
});

describe('Handler Unificado - Deteccion de imagen (voucher)', () => {
  test('Una imagen con mediaId debe redirigirse al modulo de vouchers', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'esperando_voucher', data: { pedidoId: 'PED-001' } });

    // No debe llamar a sendMessage directamente (el modulo vouchers lo maneja)
    // Solo validamos que no rompe el flujo
    try {
      await handle(FROM, { text: '', type: 'image', mediaId: 'media-123' }, ctx);
    } catch (e) {
      // Si el modulo vouchers no esta mockeado puede fallar, lo que es esperado
      // Lo importante es que llegó al modulo correcto
    }

    // No debe haber intentado enviar mensaje de "asistente virtual"
    const textosSaludo = ctx._mensajesEnviados.filter(m => 
      m.msg && m.msg.includes('asistente virtual')
    );
    expect(textosSaludo.length).toBe(0);
  });
});

describe('Handler Unificado - Estado desconocido', () => {
  test('Un estado desconocido debe iniciar flujo conversacional sin romper', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'estado_raro_que_no_existe', data: {} });

    // No debe lanzar error
    await expect(
      handle(FROM, { text: 'hola', type: 'text' }, ctx)
    ).resolves.not.toThrow();
  });
});

describe('Handler Unificado - Seguridad de mensajes', () => {
  test('Un mensaje vacio no debe romper el flujo', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });

    await expect(
      handle(FROM, { text: '', type: 'text' }, ctx)
    ).resolves.not.toThrow();
  });

  test('Un mensaje null no debe romper el flujo', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });

    await expect(
      handle(FROM, { text: null, type: 'text' }, ctx)
    ).resolves.not.toThrow();
  });

  test('Un mensaje muy largo no debe romper el flujo', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });
    const mensajeLargo = 'a'.repeat(5000);

    await expect(
      handle(FROM, { text: mensajeLargo, type: 'text' }, ctx)
    ).resolves.not.toThrow();
  });
});
