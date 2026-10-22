const { createPresentationPhotos, PhotoError, MAX_PHOTOS, pathPattern } = require('../../core/services/presentation-photos');

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROD = U(1), PRES = U(2), OTHER_PROD = U(3), OTHER_PRES = U(4);
const PUBLIC = 'https://x.supabase.co/storage/v1/object/public';

function build({ existing = [] } = {}) {
  const db = { media: existing.map((e, i) => ({ id: U(100 + i), owner_table: 'products', owner_id: PROD, role: 'gallery', bucket: 'product-images', presentation_id: PRES, sort_order: i, url: `${PUBLIC}/product-images/${e}`, path: e })) };
  const match = (r, p) => Object.entries(p).every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    const s = String(v); return s.startsWith('eq.') ? String(r[k]) === s.slice(3) : true;
  });
  const get = jest.fn(async (t, p = {}) => db[t].filter(r => match(r, p)).slice(0, p.limit || 99));
  const post = jest.fn(async (t, row) => { const r = { id: U(200 + db[t].length), ...row }; db[t].push(r); return [r]; });
  const deleteRow = jest.fn(async (t, p) => { db[t] = db[t].filter(r => !match(r, p)); });
  const signUpload = jest.fn(async (bucket, path) => `https://x.supabase.co/storage/v1/object/upload/sign/${bucket}/${path}?token=t`);
  const removeObject = jest.fn(async () => {});
  const svc = createPresentationPhotos({ get, post, deleteRow, signUpload, removeObject, publicBase: PUBLIC, now: () => 1780229543695, random: () => 'abc123', log: { error: jest.fn() } });
  return { svc, db, get, post, deleteRow, signUpload, removeObject };
}
const GOOD_PATH = `products/${PROD}/gallery-1780229543695-abc123.jpg`;
const expectErr = async (p, status) => { await expect(p).rejects.toBeInstanceOf(PhotoError); await p.catch(e => expect(e.status).toBe(status)); };

describe('prepareUpload', () => {
  test('signs an upload to a path the server chooses, in the product-images bucket', async () => {
    const { svc, signUpload } = build();
    const r = await svc.prepareUpload(PROD, PRES, 'image/png');
    expect(r.path).toBe(`products/${PROD}/gallery-1780229543695-abc123.png`);
    expect(signUpload).toHaveBeenCalledWith('product-images', r.path);
    expect(r.signedUrl).toContain('/upload/sign/product-images/');
  });
  test.each([['gif', 'image/gif'], ['pdf', 'application/pdf'], ['empty', ''], ['none', undefined]])('refuses %s', async (_l, mime) => {
    const { svc, signUpload } = build();
    await expectErr(svc.prepareUpload(PROD, PRES, mime), 400);
    expect(signUpload).not.toHaveBeenCalled();
  });
  test('refuses when the presentation already has the maximum number of photos', async () => {
    const { svc } = build({ existing: ['a', 'b', 'c'] });
    await expectErr(svc.prepareUpload(PROD, PRES, 'image/jpeg'), 409);
  });
  test('malformed ids are 404 and never reach storage', async () => {
    const { svc, signUpload } = build();
    await expectErr(svc.prepareUpload('x', PRES, 'image/jpeg'), 404);
    expect(signUpload).not.toHaveBeenCalled();
  });
});

describe('register', () => {
  test('stores the row like the website does and builds the public URL itself', async () => {
    const { svc, db } = build();
    const foto = await svc.register(PROD, PRES, GOOD_PATH, 'image/jpeg');
    expect(foto).toMatchObject({ url: `${PUBLIC}/product-images/${GOOD_PATH}`, orden: 0 });
    expect(db.media[0]).toMatchObject({ owner_table: 'products', owner_id: PROD, role: 'gallery', bucket: 'product-images', path: GOOD_PATH, mime_type: 'image/jpeg', sort_order: 0, presentation_id: PRES });
  });
  test('the next photo takes the next position', async () => {
    const { svc } = build({ existing: ['p/a', 'p/b'] });
    expect((await svc.register(PROD, PRES, GOOD_PATH, 'image/jpeg')).orden).toBe(2);
  });
  test.each([
    ['another product\'s folder', `products/${OTHER_PROD}/gallery-1780229543695-abc123.jpg`],
    ['path traversal', `products/${PROD}/../${OTHER_PROD}/gallery-1780229543695-abc123.jpg`],
    ['a different bucket folder', `farm-assets/${PROD}/gallery-1780229543695-abc123.jpg`],
    ['a wrong file name', `products/${PROD}/evil.jpg`],
    ['a wrong extension', `products/${PROD}/gallery-1780229543695-abc123.exe`],
    ['a full URL', `https://evil.com/products/${PROD}/gallery-1780229543695-abc123.jpg`],
    ['not text', 123],
  ])('refuses %s and writes nothing', async (_l, path) => {
    const { svc, post } = build();
    await expectErr(svc.register(PROD, PRES, path, 'image/jpeg'), 400);
    expect(post).not.toHaveBeenCalled();
  });
  test('refuses an unsupported type', async () => {
    await expectErr(build().svc.register(PROD, PRES, GOOD_PATH, 'image/gif'), 400);
  });
  test('refuses the same file twice and more than the maximum', async () => {
    const { svc } = build({ existing: [GOOD_PATH] });
    await expectErr(svc.register(PROD, PRES, GOOD_PATH, 'image/jpeg'), 409);
    const full = build({ existing: ['a', 'b', 'c'] });
    expect(MAX_PHOTOS).toBe(3);
    await expectErr(full.svc.register(PROD, PRES, GOOD_PATH, 'image/jpeg'), 409);
  });
});

describe('remove and list', () => {
  test('list returns the presentation\'s photos in order', async () => {
    const { svc } = build({ existing: ['p/a', 'p/b'] });
    expect((await svc.list(PRES)).map(f => f.orden)).toEqual([0, 1]);
  });
  test('removes the row and the stored file', async () => {
    const { svc, db, removeObject } = build({ existing: ['products/x/gallery-1'] });
    await svc.remove(PROD, PRES, U(100));
    expect(db.media).toHaveLength(0);
    expect(removeObject).toHaveBeenCalledWith('product-images', 'products/x/gallery-1');
  });
  test('a photo of another presentation or product looks missing and is not deleted', async () => {
    const { svc, db, deleteRow } = build({ existing: ['p/a'] });
    await expectErr(svc.remove(PROD, OTHER_PRES, U(100)), 404);
    await expectErr(svc.remove(OTHER_PROD, PRES, U(100)), 404);
    await expectErr(svc.remove(PROD, PRES, 'nope'), 404);
    expect(deleteRow).not.toHaveBeenCalled();
    expect(db.media).toHaveLength(1);
  });
  test('a failure deleting the stored file does not undo the row deletion', async () => {
    const { svc, db, removeObject } = build({ existing: ['p/a'] });
    removeObject.mockRejectedValue(new Error('storage down'));
    await svc.remove(PROD, PRES, U(100));
    expect(db.media).toHaveLength(0);
  });
});

test('the path pattern only accepts this product\'s gallery files', () => {
  const re = pathPattern(PROD);
  expect(re.test(GOOD_PATH)).toBe(true);
  expect(re.test(GOOD_PATH + '/x')).toBe(false);
});
