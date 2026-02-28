/**
 * APARTALO CORE - Helper: contexto mock para tests
 *
 * Simula WhatsApp, Sheets, Firebase y StateManager
 * sin hacer ninguna llamada real externa.
 */

function crearContextoMock(overrides = {}) {
  const mensajesEnviados = [];
  const estado = { step: 'inicio', data: {} };

  const whatsapp = {
    sendMessage: jest.fn(async (to, msg) => {
      mensajesEnviados.push({ to, msg, tipo: 'text' });
    }),
    sendButtonMessage: jest.fn(async (to, msg, botones) => {
      mensajesEnviados.push({ to, msg, botones, tipo: 'button' });
    }),
    sendImage: jest.fn(async (to, url, caption) => {
      mensajesEnviados.push({ to, url, caption, tipo: 'image' });
    }),
    markAsRead: jest.fn(async () => {})
  };

  const sheets = {
    initialize: jest.fn(async () => {}),
    buscarCliente: jest.fn(async () => null),
    getProductos: jest.fn(async () => []),
    getProductosConPrecios: jest.fn(async () => [
      { codigo: 'CAF-001', nombre: 'Cafe Especial 250g', precio: 25 },
      { codigo: 'CAF-002', nombre: 'Cafe Natural 500g', precio: 45 }
    ]),
    getPedidosByWhatsapp: jest.fn(async () => []),
    getMetodosPago: jest.fn(async () => [
      { tipo: 'yape', numero: '999888777', titular: 'Finca Rosal' }
    ]),
    crearPedido: jest.fn(async () => ({ id: 'PED-TEST-001' })),
    upsertCliente: jest.fn(async () => {}),
    getRows: jest.fn(async () => []),
    appendRow: jest.fn(async () => {}),
    updateCell: jest.fn(async () => {})
  };

  const stateManager = {
    getState: jest.fn(() => ({ ...estado })),
    setState: jest.fn((from, negocioId, nuevoEstado) => {
      Object.assign(estado, nuevoEstado);
    }),
    setStep: jest.fn((from, negocioId, step) => {
      estado.step = step;
    }),
    updateData: jest.fn((from, negocioId, data) => {
      estado.data = { ...estado.data, ...data };
    }),
    resetState: jest.fn(() => {
      estado.step = 'inicio';
      estado.data = {};
    }),
    getActiveBusiness: jest.fn(() => null),
    setActiveBusiness: jest.fn(() => {}),
    clearActiveBusiness: jest.fn(() => {})
  };

  const firebaseService = {
    initialized: false,
    guardarMensaje: jest.fn(async () => {}),
    cambiarModo: jest.fn(async () => {}),
    notificarMensajeSoporte: jest.fn(async () => {})
  };

  const asesorService = {
    activarModoAsesor: jest.fn(async () => ({
      success: true,
      conversacionId: 'CONV-TEST-001',
      mensaje: 'Conectado con Asesoria\n\nEscribe tu consulta y te responderemos pronto.\n\nEscribe "menu" para volver al menu.'
    })),
    debeBloquerBot: jest.fn(async () => false),
    guardarMensajeAuto: jest.fn(async () => ({ success: true }))
  };

  const negocio = {
    id: 'BIZ-002',
    nombre: 'Finca Rosal',
    features: ['asesorHumano', 'muestras'],
    whatsapp: { phoneId: '123456', token: 'test-token', tipo: 'PROPIO' },
    spreadsheetId: 'test-sheet-id',
    configExtra: {
      unidad: 'kg',
      minimoCompra: 1,
      flujoPago: 'voucher',
      mostrarFotos: true,
      prefijoPedido: 'PED',
      usarIA: true
    }
  };

  const contexto = {
    negocio,
    whatsapp,
    sheets,
    stateManager,
    firebaseService,
    asesorService,
    hasFeature: jest.fn((feature) => negocio.features.includes(feature)),
    config: negocio.configExtra || {},
    // Helper para tests: ver todos los mensajes enviados
    _mensajesEnviados: mensajesEnviados,
    _estado: estado
  };

  return { ...contexto, ...overrides };
}

module.exports = { crearContextoMock };
