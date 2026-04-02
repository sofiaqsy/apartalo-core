/**
 * UNIT TESTS — handlers/delivery/index.js
 *
 * Covers the courier message handler:
 *   - Delivery completed keywords → mark order COMPLETADO
 *   - No active orders → reply with "no tienes deliveries"
 *   - Multiple active orders → ask which one
 *   - Number reply to select order → mark specific order
 *   - "Mis pedidos" → list active orders
 *   - Unknown message → guide message
 */

const { handle } = require('../../handlers/delivery/index');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContext(pedidoRows = []) {
  const mockSheets = {
    getRows: jest.fn().mockImplementation(async (range) => {
      if (range.includes('Pedidos')) return pedidoRows;
      return [['header']];
    }),
    updateCell: jest.fn().mockResolvedValue(undefined),
  };
  const mockWa = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
  };
  return { sheets: mockSheets, whatsapp: mockWa, _sheets: mockSheets, _wa: mockWa };
}

const COURIER = '51962763381';

// Build a Pedidos row (cols: id, fecha, hora, whatsapp, nombre, tel, dir, prod, total, estado, evidencias, obs, tipoEnvio)
function pedidoRow({ id = 'PED-00000001', whatsapp = COURIER, estado = 'PENDIENTE', tipoEnvio = 'DELIVERY', obs = 'Destino: Jr Lima 123', rowIndex = 2 } = {}) {
  const row = Array(13).fill('');
  row[0] = id;
  row[3] = whatsapp;
  row[9] = estado;
  row[11] = obs;
  row[12] = tipoEnvio;
  return row;
}

const HEADERS = ['id', 'fecha', 'hora', 'whatsapp', 'nombre', 'tel', 'dir', 'prod', 'total', 'estado', 'evidencias', 'obs', 'tipoEnvio'];

// ── Tests: delivery completed ─────────────────────────────────────────────────

describe('delivery handler — entregado keywords', () => {
  beforeEach(() => jest.clearAllMocks());

  const entregadoVariants = ['ya entregué', 'entregue', 'listo', 'entregado', 'terminé', 'completado'];

  test.each(entregadoVariants)('"%s" marks single active order as COMPLETADO', async (keyword) => {
    const rows = [HEADERS, pedidoRow()];
    const ctx = makeContext(rows);
    await handle(COURIER, keyword, ctx);
    expect(ctx._sheets.updateCell).toHaveBeenCalledWith('Pedidos!J2', 'COMPLETADO');
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('Delivery')
    );
  });

  test('sends "no tienes deliveries" when courier has no active orders', async () => {
    const ctx = makeContext([HEADERS]); // no rows
    await handle(COURIER, 'ya entregué', ctx);
    expect(ctx._sheets.updateCell).not.toHaveBeenCalled();
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('No tienes deliveries')
    );
  });

  test('skips orders that are not PENDIENTE', async () => {
    const rows = [HEADERS, pedidoRow({ estado: 'COMPLETADO' })];
    const ctx = makeContext(rows);
    await handle(COURIER, 'listo', ctx);
    expect(ctx._sheets.updateCell).not.toHaveBeenCalled();
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('No tienes deliveries')
    );
  });

  test('skips orders that are not DELIVERY type', async () => {
    const rows = [HEADERS, pedidoRow({ tipoEnvio: 'RECOJO' })];
    const ctx = makeContext(rows);
    await handle(COURIER, 'ya entregue', ctx);
    expect(ctx._sheets.updateCell).not.toHaveBeenCalled();
  });

  test('skips orders belonging to a different courier', async () => {
    const rows = [HEADERS, pedidoRow({ whatsapp: '51999999999' })];
    const ctx = makeContext(rows);
    await handle(COURIER, 'ya entregué', ctx);
    expect(ctx._sheets.updateCell).not.toHaveBeenCalled();
  });

  test('matches courier only when phone numbers are identical after stripping non-digits', async () => {
    // Handler uses exact === match — both sides stripped of non-digits
    const rows = [HEADERS, pedidoRow({ whatsapp: '51962763381' })];
    const ctx = makeContext(rows);
    await handle('51962763381', 'listo', ctx);
    expect(ctx._sheets.updateCell).toHaveBeenCalled();
  });

  test('asks which order when courier has multiple active deliveries', async () => {
    const rows = [
      HEADERS,
      pedidoRow({ id: 'PED-00000001' }),
      pedidoRow({ id: 'PED-00000002' }),
    ];
    const ctx = makeContext(rows);
    await handle(COURIER, 'ya entregué', ctx);
    expect(ctx._sheets.updateCell).not.toHaveBeenCalled();
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('2 deliveries activos')
    );
  });
});

// ── Tests: number reply to select order ──────────────────────────────────────

describe('delivery handler — number reply', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reply "1" marks first active order as COMPLETADO', async () => {
    const rows = [
      HEADERS,
      pedidoRow({ id: 'PED-00000001' }),
      pedidoRow({ id: 'PED-00000002' }),
    ];
    const ctx = makeContext(rows);
    await handle(COURIER, '1', ctx);
    expect(ctx._sheets.updateCell).toHaveBeenCalledWith('Pedidos!J2', 'COMPLETADO');
  });

  test('reply "2" marks second active order as COMPLETADO', async () => {
    const rows = [
      HEADERS,
      pedidoRow({ id: 'PED-00000001' }),
      pedidoRow({ id: 'PED-00000002' }),
    ];
    const ctx = makeContext(rows);
    await handle(COURIER, '2', ctx);
    expect(ctx._sheets.updateCell).toHaveBeenCalledWith('Pedidos!J3', 'COMPLETADO');
  });
});

// ── Tests: mis pedidos ────────────────────────────────────────────────────────

describe('delivery handler — mis pedidos', () => {
  beforeEach(() => jest.clearAllMocks());

  const listVariants = ['mis pedidos', 'qué tengo', 'que tengo', 'mis deliveries'];

  test.each(listVariants)('"%s" lists active orders', async (keyword) => {
    const rows = [HEADERS, pedidoRow({ id: 'PED-00000001' })];
    const ctx = makeContext(rows);
    await handle(COURIER, keyword, ctx);
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('PED-00000001')
    );
  });

  test('"mis pedidos" sends no-deliveries message when list is empty', async () => {
    const ctx = makeContext([HEADERS]);
    await handle(COURIER, 'mis pedidos', ctx);
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('No tienes deliveries')
    );
  });
});

// ── Tests: unknown message ────────────────────────────────────────────────────

describe('delivery handler — default guide', () => {
  beforeEach(() => jest.clearAllMocks());

  test('unknown message sends guide with available commands', async () => {
    const ctx = makeContext([HEADERS]);
    await handle(COURIER, 'hola cómo estás', ctx);
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('Ya entregué')
    );
  });

  test('empty message sends guide', async () => {
    const ctx = makeContext([HEADERS]);
    await handle(COURIER, '', ctx);
    expect(ctx._wa.sendMessage).toHaveBeenCalledWith(
      COURIER,
      expect.stringContaining('Mis pedidos')
    );
  });
});
