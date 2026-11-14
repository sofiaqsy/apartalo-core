const { createLectorComprobantes, leerComprobante, leerFecha } = require('../../core/services/lector-comprobantes');

describe('lector de comprobantes (14 Nov 2026)', () => {
  test('reads a BCP transfer: date, amount and operation', () => {
    const texto = [
      'TRANSFERENCIA A TERCEROS BCP', 'Monto transferido', 'S/ 220.00',
      'Martes, 10 Noviembre 2026 - 06:46 p.m.', 'Enviado a', 'Número de operación 05098337',
    ].join('\n');
    expect(leerComprobante(texto)).toEqual({ fecha: '2026-11-10', monto: 220, operacion: '05098337' });
  });

  test('reads a Yape voucher', () => {
    const texto = ['¡Yapeaste!', 'S/ 1,811', '20 jul. 2026 - 06:48 pm', 'Nro. de operación', '06119540'].join('\n');
    const r = leerComprobante(texto);
    expect(r.fecha).toBe('2026-07-20');
    expect(r.monto).toBe(1811);
  });

  test('dates in the common ways, and nothing invented', () => {
    expect(leerFecha('10 de noviembre de 2026')).toBe('2026-11-10');
    expect(leerFecha('Fecha: 13/11/2026 14:37')).toBe('2026-11-13');
    expect(leerFecha('5 set. 2026')).toBe('2026-09-05');
    expect(leerFecha('31 febrero 2026')).toBeNull();
    expect(leerFecha('sin fecha')).toBeNull();
  });

  test('the amount ignores comisión and saldo', () => {
    expect(leerComprobante('Monto S/ 150.00\nComisión S/ 1.00\nSaldo disponible S/ 9,999.00').monto).toBe(150);
  });

  function reply(status, body) {
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  }

  test('each voucher not read yet is read once and saved; one that fails is saved with its error', async () => {
    const guardados = [];
    const fetchImpl = jest.fn(async (url, opts) => {
      if (url.endsWith('rpc/proofs_to_read')) {
        return reply(200, [{ id: 'p1', url: 'https://img.example/a.jpg' }, { id: 'p2', url: 'https://img.example/roto.jpg' }]);
      }
      if (url.endsWith('rpc/proof_reading_save')) { guardados.push(JSON.parse(opts.body)); return reply(200, true); }
      if (url.endsWith('a.jpg')) return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(4) };
      return { ok: false, status: 404, headers: { get: () => 'text/html' } };
    });
    const lector = createLectorComprobantes({
      negocios: () => [{ id: 'BIZ-002', farmId: 'farm-rosal' }, { id: 'BIZ-001' }],
      ocr: async () => 'Monto S/ 220.00\nMartes, 10 Noviembre 2026\nNúmero de operación 05098337',
      fetchImpl, supabaseUrl: () => 'https://db.example', serviceKey: () => 'service',
      log: { log: () => {}, error: () => {} },
    });
    expect(await lector.revisar()).toEqual({ leidos: 1, fallidos: 1 });
    expect(guardados).toEqual([
      { p_proof_id: 'p1', p_fecha: '2026-11-10', p_monto: 220, p_operacion: '05098337', p_error: null },
      { p_proof_id: 'p2', p_error: 'descarga 404' },
    ]);
    const pedido = fetchImpl.mock.calls.find(c => c[0].endsWith('rpc/proofs_to_read'));
    expect(JSON.parse(pedido[1].body)).toEqual({ p_business_id: 'farm-rosal', p_limit: 5 });
    expect(pedido[1].headers.Authorization).toBe('Bearer service');
  });

  test('without the service key nothing is asked', async () => {
    const fetchImpl = jest.fn();
    const lector = createLectorComprobantes({ negocios: () => [{ farmId: 'f' }], ocr: async () => '', fetchImpl, supabaseUrl: () => 'x', serviceKey: () => '' });
    expect(await lector.revisar()).toEqual({ leidos: 0, fallidos: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
