const mockGet = jest.fn();
jest.mock('../../core/services/supabase-service', () => ({ get: (...a) => mockGet(...a) }));

function fresh() { jest.resetModules(); return require('../../config/negocios'); }

describe('loadFromFarms', () => {
  beforeEach(() => mockGet.mockReset());

  test('adds approved farms that are not configured, with safe defaults', async () => {
    const svc = fresh();
    svc.loadFromLocal();
    const rosalFarm = svc.getById('BIZ-002').farmId;
    mockGet.mockResolvedValue([
      { id: rosalFarm, slug: 'finca-rosal', name: 'Finca Rosal', city: 'Villa Rica' },
      { id: 'f-new', slug: 'cafe-luis', name: 'Café Luis', city: 'Lima' },
      { id: 'f-empty', slug: '', name: 'Sin slug', city: '' },
    ]);
    await svc.loadFromFarms();
    expect(svc.getAll().map(n => n.id).sort()).toEqual(['BIZ-002', 'BIZ-CAFE-LUIS']);
    const n = svc.getById('BIZ-CAFE-LUIS');
    expect(n).toMatchObject({ nombre: 'Café Luis', farmId: 'f-new', flujo: 'STANDARD', features: [] });
    expect(n.whatsapp.tipo).toBe('NINGUNO');
    expect(svc.getSharedNegocios().map(x => x.id)).toEqual(['BIZ-002']);   // never joins the WhatsApp flows
  });

  test('running twice does not duplicate, and a failure never throws', async () => {
    const svc = fresh(); svc.loadFromLocal();
    mockGet.mockResolvedValue([{ id: 'f-new', slug: 'cafe-luis', name: 'Café Luis' }]);
    await svc.loadFromFarms(); await svc.loadFromFarms();
    expect(svc.getAll()).toHaveLength(2);
    mockGet.mockRejectedValue(new Error('db down'));
    await expect(svc.loadFromFarms()).resolves.toBeUndefined();
    expect(svc.getAll()).toHaveLength(2);
  });
});
