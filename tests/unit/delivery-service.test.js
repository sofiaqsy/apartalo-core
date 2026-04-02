/**
 * UNIT TESTS — delivery-service.js
 *
 * Tests all core delivery logic with mocked Sheets and WhatsApp.
 * No real API calls are made.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../core/services/sheets-service');
jest.mock('../../core/services/whatsapp-service');

const SheetsService = require('../../core/services/sheets-service');
const WhatsAppService = require('../../core/services/whatsapp-service');
const { notificarNuevoDelivery, asignarDelivery } = require('../../core/services/delivery-service');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNegocioOrigen(overrides = {}) {
  return {
    id: 'BIZ-000',
    nombre: 'Tienda Test',
    spreadsheetId: 'sheet-biz000',
    configExtra: {
      deliveryBizId: 'BIZ-000',
      precioDelivery: 8,
    },
    whatsapp: { phoneId: 'phone-000', token: 'tok-000', tipo: 'PROPIO' },
    ...overrides,
  };
}

function makeNegocioDelivery() {
  return {
    id: 'BIZ-000',
    nombre: 'Delivery Test',
    spreadsheetId: 'sheet-biz000',
    whatsapp: { phoneId: 'phone-000', token: 'tok-000', tipo: 'PROPIO' },
    configExtra: { isDeliveryBusiness: true },
  };
}

function makeNegociosService(deliveryNegocio = makeNegocioDelivery()) {
  return { getById: jest.fn(() => deliveryNegocio) };
}

function makePedido(overrides = {}) {
  return {
    id: 'PED-12345678',
    whatsapp: '51936934501',
    cliente: 'Test Cliente',
    telefono: '51936934501',
    direccion: 'Jr Principal 123',
    ciudad: '',
    departamento: '',
    productos: '1x Cafe - S/35.00',
    total: 35,
    testMode: true,
    ...overrides,
  };
}

// ── Shared sheet mock setup ───────────────────────────────────────────────────

function setupSheetsMock({ configRows, clienteRows, courierRows } = {}) {
  const mockSheets = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getRows: jest.fn().mockImplementation(async (range) => {
      if (range.includes('Configuracion')) {
        return configRows || [
          ['Campo', 'Valor'],
          ['departamento', 'Lima'],
          ['direccion_tienda', 'Av. Principal 123, Miraflores'],
        ];
      }
      if (range.includes('Clientes')) {
        return clienteRows || [
          ['ID', 'WhatsApp', 'Nombre', 'Responsable', 'Telefono', 'Email', 'Direccion', 'Departamento', 'Distrito'],
          ['CLI-001', '51936934501', 'Test Cliente', '', '51936934501', '', 'Jr Principal 123', 'Lima', 'Miraflores'],
        ];
      }
      return [['header']];
    }),
    appendRow: jest.fn().mockResolvedValue(undefined),
    updateCell: jest.fn().mockResolvedValue(undefined),
  };

  SheetsService.mockImplementation(() => mockSheets);
  return mockSheets;
}

function setupWhatsAppMock() {
  const mockWa = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendButtonMessage: jest.fn().mockResolvedValue(undefined),
  };
  WhatsAppService.mockImplementation(() => mockWa);
  return mockWa;
}

// ── Tests: notificarNuevoDelivery ─────────────────────────────────────────────

describe('notificarNuevoDelivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips if no deliveryBizId in configExtra', async () => {
    const sheets = setupSheetsMock();
    const negocio = makeNegocioOrigen({ configExtra: {} });
    await notificarNuevoDelivery(makePedido(), negocio, makeNegociosService());
    expect(sheets.appendRow).not.toHaveBeenCalled();
  });

  test('skips if delivery business not found', async () => {
    const sheets = setupSheetsMock();
    const negociosService = { getById: jest.fn(() => null) };
    await notificarNuevoDelivery(makePedido(), makeNegocioOrigen(), negociosService);
    expect(sheets.appendRow).not.toHaveBeenCalled();
  });

  test('skips if customer has no address', async () => {
    setupSheetsMock();
    const pedido = makePedido({ direccion: '' });
    const sheets = setupSheetsMock({
      clienteRows: [
        ['ID', 'WhatsApp', 'Nombre', 'Responsable', 'Telefono', 'Email', 'Direccion', 'Departamento', 'Distrito'],
        ['CLI-001', '51936934501', 'Test', '', '', '', '', 'Lima', 'Miraflores'], // no direccion
      ],
    });
    await notificarNuevoDelivery(pedido, makeNegocioOrigen(), makeNegociosService());
    expect(sheets.appendRow).not.toHaveBeenCalled();
  });

  test('skips if customer city does not match store city', async () => {
    const sheets = setupSheetsMock({
      clienteRows: [
        ['ID', 'WhatsApp', 'Nombre', 'Responsable', 'Telefono', 'Email', 'Direccion', 'Departamento', 'Distrito'],
        ['CLI-001', '51936934501', 'Test', '', '', '', 'Jr Principal 123', 'Arequipa', 'Cercado'], // different city
      ],
    });
    await notificarNuevoDelivery(makePedido(), makeNegocioOrigen(), makeNegociosService());
    expect(sheets.appendRow).not.toHaveBeenCalled();
  });

  test('registers delivery product in Inventario when all filters pass', async () => {
    const sheets = setupSheetsMock();
    setupWhatsAppMock();
    await notificarNuevoDelivery(makePedido(), makeNegocioOrigen(), makeNegociosService());
    expect(sheets.appendRow).toHaveBeenCalledWith(
      'Inventario',
      expect.arrayContaining([
        expect.stringMatching(/^DEL-/),   // deliveryId
        expect.stringContaining('Tienda Test'), // product name
      ])
    );
  });

  test('stores precioDelivery from configExtra in product row', async () => {
    const sheets = setupSheetsMock();
    setupWhatsAppMock();
    await notificarNuevoDelivery(makePedido(), makeNegocioOrigen(), makeNegociosService());
    const call = sheets.appendRow.mock.calls.find(c => c[0] === 'Inventario');
    expect(call).toBeDefined();
    const row = call[1];
    expect(row[3]).toBe(8); // precio = 8 (from configExtra.precioDelivery)
  });

  test('skips WhatsApp broadcast in testMode', async () => {
    setupSheetsMock({
      clienteRows: [
        ['ID', 'WhatsApp'],
        ['CLI-001', '51936934501'],
      ],
    });
    const wa = setupWhatsAppMock();
    await notificarNuevoDelivery(makePedido({ testMode: true }), makeNegocioOrigen(), makeNegociosService());
    expect(wa.sendButtonMessage).not.toHaveBeenCalled();
    expect(wa.sendMessage).not.toHaveBeenCalled();
  });
});

// ── Tests: asignarDelivery ────────────────────────────────────────────────────

describe('asignarDelivery', () => {
  beforeEach(() => jest.clearAllMocks());

  function makeContext(invRows, pedidoRows) {
    const mockSheets = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getRows: jest.fn().mockImplementation(async (range) => {
        if (range.includes('Inventario')) return invRows;
        if (range.includes('Pedidos')) return pedidoRows || [['header']];
        if (range.includes('Clientes')) {
          return [
            ['ID', 'WhatsApp', 'Nombre'],
            ['CLI-001', '51962763381', 'Repartidor Test'],
          ];
        }
        return [['header']];
      }),
      appendRow: jest.fn().mockResolvedValue(undefined),
      updateCell: jest.fn().mockResolvedValue(undefined),
    };
    const mockWa = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      sendButtonMessage: jest.fn().mockResolvedValue(undefined),
    };
    WhatsAppService.mockImplementation(() => mockWa);
    return {
      negocio: makeNegocioDelivery(),
      sheets: mockSheets,
      whatsapp: mockWa,
      _mockSheets: mockSheets,
      _mockWa: mockWa,
    };
  }

  const ACTIVE_DELIVERY = [
    ['codigo', 'nombre', 'descripcion', 'precio', 'stock', 'stockReservado', 'imagenUrl', 'estado', 'categoria'],
    ['DEL-99999999', 'Delivery: Cafe Zuma → Jr Principal 123', JSON.stringify({
      originLabel: 'Av. Principal 123, Miraflores',
      destination: 'Jr Principal 123, Miraflores',
      rawDireccion: 'Jr Principal 123',
      productos: '1x Cafe',
      precioDelivery: 8,
    }), 8, 1, 0, '', 'ACTIVO', 'DELIVERY'],
  ];

  const TAKEN_DELIVERY = [
    ['codigo', 'nombre', 'descripcion', 'precio', 'stock', 'stockReservado', 'imagenUrl', 'estado', 'categoria'],
    ['DEL-99999999', 'Delivery: Cafe Zuma → Jr Principal 123', '{}', 0, 1, 0, '', 'INACTIVO', 'DELIVERY'],
  ];

  test('assigns delivery and creates order when product is ACTIVO', async () => {
    const ctx = makeContext(ACTIVE_DELIVERY);
    await asignarDelivery('51962763381', 'delivery_yes_DEL-99999999', ctx);

    // Product should be marked INACTIVO
    expect(ctx._mockSheets.updateCell).toHaveBeenCalledWith(
      expect.stringMatching(/Inventario!H\d+/), 'INACTIVO'
    );
    // A new order should be created in Pedidos
    expect(ctx._mockSheets.appendRow).toHaveBeenCalledWith(
      'Pedidos',
      expect.arrayContaining([expect.stringMatching(/^PED-/)])
    );
    // Confirmation message sent to courier
    expect(ctx._mockWa.sendMessage).toHaveBeenCalledWith(
      '51962763381',
      expect.stringContaining('Delivery asignado')
    );
  });

  test('order is created with correct price from delivery product', async () => {
    const ctx = makeContext(ACTIVE_DELIVERY);
    await asignarDelivery('51962763381', 'delivery_yes_DEL-99999999', ctx);
    const orderRow = ctx._mockSheets.appendRow.mock.calls.find(c => c[0] === 'Pedidos')[1];
    expect(orderRow[8]).toBe(8); // total = 8 (precioDelivery)
  });

  test('rejects if delivery is already INACTIVO (taken)', async () => {
    const ctx = makeContext(TAKEN_DELIVERY);
    await asignarDelivery('51962763381', 'delivery_yes_DEL-99999999', ctx);

    expect(ctx._mockSheets.updateCell).not.toHaveBeenCalled();
    expect(ctx._mockSheets.appendRow).not.toHaveBeenCalled();
    expect(ctx._mockWa.sendMessage).toHaveBeenCalledWith(
      '51962763381',
      expect.stringContaining('ya fue tomado')
    );
  });

  test('rejects if delivery product not found', async () => {
    const ctx = makeContext([['header']]);
    await asignarDelivery('51962763381', 'delivery_yes_DEL-00000000', ctx);

    expect(ctx._mockSheets.appendRow).not.toHaveBeenCalled();
    expect(ctx._mockWa.sendMessage).toHaveBeenCalledWith(
      '51962763381',
      expect.stringContaining('No se encontró')
    );
  });
});
