/**
 * APARTALO CORE - Tests: Flujos de conversacion completos
 *
 * Simula secuencias de mensajes como si fuera un cliente real.
 * Cada test representa un escenario completo de principio a fin.
 *
 * ESCENARIOS:
 * 1. Cliente nuevo saluda y hace un pedido completo
 * 2. Cliente pide hablar con la finca en medio de una conversacion
 * 3. Cliente escribe mal / mensajes inesperados
 * 4. Cliente intenta hacer pedido sin datos de entrega
 * 5. Cliente cancela en pleno proceso
 */

jest.mock('../../core/services/ai-service', () => ({
  procesarMensaje: jest.fn(async () => ({
    respuesta: '',
    accion: 'menu',
    datos: {}
  })),
  initialized: true,
  initialize: jest.fn(async () => true)
}));

jest.mock('../../core/utils/formatters', () => ({
  getGreeting: jest.fn(() => 'Buenos dias'),
  generateId: jest.fn(() => 'PED-CONV-001')
}));

const aiOrderService = require('../../core/services/ai-order-service');
jest.mock('../../core/services/ai-order-service', () => ({
  procesarMensajePedido: jest.fn()
}));

const { handle } = require('../../handlers/unificado/index');
const { crearContextoMock } = require('../helpers/mockContext');

const FROM = '51988777666';

// Helper para enviar mensaje y capturar respuesta
async function enviarMensaje(ctx, text, type = 'text', extra = {}) {
  ctx._mensajesEnviados.length = 0; // limpiar mensajes anteriores
  await handle(FROM, { text, type, ...extra }, ctx);
  return ctx._mensajesEnviados;
}

// ============================================================
// ESCENARIO 1: Cliente nuevo que hace un pedido completo
// ============================================================
describe('Escenario: Cliente nuevo hace pedido completo', () => {
  let ctx;

  beforeEach(() => {
    ctx = crearContextoMock();

    // Simular progresion de estados
    let step = 'inicio';
    ctx.stateManager.getState.mockImplementation(() => ({ step, data: {} }));
    ctx.stateManager.setState.mockImplementation((f, n, nuevoEstado) => {
      step = nuevoEstado.step || step;
    });
    ctx.stateManager.setStep.mockImplementation((f, n, s) => { step = s; });
  });

  test('1. El primer saludo identifica al bot y ofrece contactar finca', async () => {
    const respuestas = await enviarMensaje(ctx, 'menu');
    expect(respuestas.length).toBeGreaterThan(0);
    expect(respuestas[0].msg).toContain('asistente virtual');
    expect(respuestas[0].msg.toLowerCase()).toContain('contactar finca');
  });

  test('2. El bot responde al saludo del cliente', async () => {
    aiOrderService.procesarMensajePedido.mockResolvedValueOnce({
      respuesta: 'Buenos dias. Tenemos cafe de Villa Rica. ¿Deseas ver el catalogo?',
      pedidoCompleto: false,
      datosExtraidos: {},
      error: false
    });

    ctx.stateManager.getState.mockReturnValue({ step: 'pedido_conversacional', data: { historial: [] } });
    const respuestas = await enviarMensaje(ctx, 'hola');
    expect(respuestas.length).toBeGreaterThan(0);
  });

  test('3. El bot no rompe si la IA devuelve error', async () => {
    aiOrderService.procesarMensajePedido.mockResolvedValueOnce({
      respuesta: 'Ocurrio un problema. Intenta nuevamente.',
      pedidoCompleto: false,
      datosExtraidos: {},
      error: true
    });

    ctx.stateManager.getState.mockReturnValue({ step: 'pedido_conversacional', data: { historial: [] } });
    const respuestas = await enviarMensaje(ctx, 'quiero cafe');
    expect(respuestas.length).toBeGreaterThan(0);
    expect(respuestas[0].msg).toContain('problema');
  });
});

// ============================================================
// ESCENARIO 2: Cliente pide hablar con la finca en medio de una compra
// ============================================================
describe('Escenario: Cliente interrumpe pedido para contactar finca', () => {
  test('Debe activar modo asesor y no continuar el flujo de pedido', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({
      step: 'pedido_conversacional',
      data: { historial: ['algo sobre cafe'], datosExtraidos: {} }
    });

    await enviarMensaje(ctx, 'mejor quiero hablar con la finca');

    expect(ctx.asesorService.activarModoAsesor).toHaveBeenCalled();
    // No debe haber procesado como pedido
    expect(aiOrderService.procesarMensajePedido).not.toHaveBeenCalled();
  });

  test('Escribir "finca" a secas debe conectar con asesor', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });

    await enviarMensaje(ctx, 'finca');

    expect(ctx.asesorService.activarModoAsesor).toHaveBeenCalled();
  });
});

// ============================================================
// ESCENARIO 3: Cliente escribe mensajes inesperados
// ============================================================
describe('Escenario: Mensajes inesperados o mal escritos', () => {
  const casosRaros = [
    '',
    '   ',
    '????',
    '12345678901234567890',
    'HOLA HOLA HOLA HOLA',
    'muéstrame todo lo que tienes disponible por favor',
    'asdfghjkl',
  ];

  casosRaros.forEach((texto) => {
    test(`No debe lanzar excepcion con mensaje: "${texto.substring(0, 30)}"`, async () => {
      const ctx = crearContextoMock();
      aiOrderService.procesarMensajePedido.mockResolvedValue({
        respuesta: '¿En qué te puedo ayudar?',
        pedidoCompleto: false,
        datosExtraidos: {},
        error: false
      });
      ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });

      await expect(
        handle(FROM, { text: texto, type: 'text' }, ctx)
      ).resolves.not.toThrow();
    });
  });
});

// ============================================================
// ESCENARIO 4: Cliente cancela en pleno proceso
// ============================================================
describe('Escenario: Cliente cancela antes de confirmar pedido', () => {
  test('Cancelar debe resetear estado y enviar confirmacion de cancelacion', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({
      step: 'confirmar_pedido',
      data: {
        productosParaPedido: [{ codigo: 'CAF-001', nombre: 'Cafe', cantidad: 2, precio: 25 }],
        total: 50,
        nombreCliente: 'Maria',
        direccion: 'Av. Lima 123'
      }
    });

    const respuestas = await enviarMensaje(ctx, 'cancelar');

    expect(ctx.stateManager.resetState).toHaveBeenCalled();
    expect(respuestas[0].msg.toLowerCase()).toContain('cancelad');
  });

  test('Confirmar "no" en botones debe cancelar el pedido', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({
      step: 'confirmar_pedido',
      data: {
        productosParaPedido: [{ codigo: 'CAF-001', nombre: 'Cafe', cantidad: 2, precio: 25 }],
        total: 50,
        nombreCliente: 'Maria',
        direccion: 'Av. Lima 123'
      }
    });

    const respuestas = await enviarMensaje(ctx, 'confirmar_no', 'interactive', {
      interactiveData: { id: 'confirmar_no', title: 'Cancelar', type: 'button' }
    });

    expect(ctx.stateManager.resetState).toHaveBeenCalled();
  });
});

// ============================================================
// ESCENARIO 5: Consistencia de tono (sin emojis, sin ser condescendiente)
// ============================================================
describe('Escenario: Calidad de mensajes del bot', () => {
  const emojiRegex = /[\u{1F300}-\u{1FFFF}]/u;

  test('El saludo no contiene emojis', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'menu', data: {} });
    const respuestas = await enviarMensaje(ctx, 'menu');
    expect(emojiRegex.test(respuestas[0].msg)).toBe(false);
  });

  test('El mensaje de cancelacion no contiene emojis', async () => {
    const ctx = crearContextoMock();
    ctx.stateManager.getState.mockReturnValue({ step: 'pedido_conversacional', data: {} });
    const respuestas = await enviarMensaje(ctx, 'cancelar');
    expect(emojiRegex.test(respuestas[0].msg)).toBe(false);
  });

  test('El mensaje de contactar finca (sin feature) no contiene emojis', async () => {
    const ctx = crearContextoMock();
    ctx.hasFeature.mockReturnValue(false);
    ctx.stateManager.getState.mockReturnValue({ step: 'inicio', data: {} });
    const respuestas = await enviarMensaje(ctx, 'contactar finca');
    expect(emojiRegex.test(respuestas[0].msg)).toBe(false);
  });
});
