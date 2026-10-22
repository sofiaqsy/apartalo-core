/**
 * PRESENTATION PHOTOS: up to 3 photos per presentation, stored the same way the website does.
 *
 *   storage : bucket 'product-images', path products/<productId>/gallery-<timestamp>-<random>.<ext>
 *   database: media row { owner_table:'products', owner_id:<productId>, role:'gallery', bucket, path, url,
 *             mime_type, sort_order:0..2, presentation_id:<presentationId> }
 *
 * Flow (the phone never sends the URL it wants saved, the server builds it):
 *   1. prepareUpload  -> signed upload URL for a server-chosen path
 *   2. the phone PUTs the bytes to that URL
 *   3. register       -> checks the path is one this product could have been given, then stores the row
 * Ownership of product and presentation is checked by the route guards before these functions run.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'product-images';
const MAX_PHOTOS = 3;
const MIME_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });

class PhotoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pathPattern(productId) {
  return new RegExp(`^products/${escapeRe(productId)}/gallery-\\d{10,15}-[a-z0-9]{4,10}\\.(jpg|png|webp)$`, 'i');
}

/**
 * @param {object} deps
 * @param {(path:string, params?:object)=>Promise<any>} deps.get
 * @param {(path:string, body:object)=>Promise<any>} deps.post
 * @param {(path:string, params:object)=>Promise<void>} deps.deleteRow
 * @param {(bucket:string, path:string)=>Promise<string>} deps.signUpload   returns the signed upload URL
 * @param {(bucket:string, path:string)=>Promise<void>} deps.removeObject   best effort
 * @param {string} deps.publicBase  e.g. https://x.supabase.co/storage/v1/object/public
 */
function createPresentationPhotos({ get, post, deleteRow, signUpload, removeObject, publicBase, now = () => Date.now(), random = () => Math.random().toString(36).slice(2, 8), log = console }) {
  const check = (productId, presentationId) => {
    if (!UUID.test(String(productId || '')) || !UUID.test(String(presentationId || ''))) throw new PhotoError(404, 'Presentación no encontrada');
  };

  async function rows(presentationId) {
    return get('media', {
      presentation_id: `eq.${presentationId}`, owner_table: 'eq.products', role: 'eq.gallery',
      select: 'id,url,path,sort_order', order: 'sort_order.asc',
    });
  }

  const toApi = r => ({ id: r.id, url: r.url, orden: r.sort_order });

  async function list(presentationId) {
    return (await rows(presentationId)).map(toApi);
  }

  async function prepareUpload(productId, presentationId, mimeType) {
    check(productId, presentationId);
    const ext = MIME_EXT[String(mimeType || '').toLowerCase()];
    if (!ext) throw new PhotoError(400, 'Formato no permitido. Usa JPG, PNG o WEBP.');
    if ((await rows(presentationId)).length >= MAX_PHOTOS) throw new PhotoError(409, `Máximo ${MAX_PHOTOS} fotos por presentación`);
    const path = `products/${productId}/gallery-${now()}-${random()}.${ext}`;
    const signedUrl = await signUpload(BUCKET, path);
    return { signedUrl, path };
  }

  async function register(productId, presentationId, path, mimeType) {
    check(productId, presentationId);
    if (typeof path !== 'string' || !pathPattern(productId).test(path)) throw new PhotoError(400, 'La foto no es válida');
    const ext = MIME_EXT[String(mimeType || '').toLowerCase()];
    if (!ext) throw new PhotoError(400, 'Formato no permitido. Usa JPG, PNG o WEBP.');

    const existing = await rows(presentationId);
    if (existing.length >= MAX_PHOTOS) throw new PhotoError(409, `Máximo ${MAX_PHOTOS} fotos por presentación`);
    const used = await get('media', { path: `eq.${path}`, select: 'id', limit: 1 });
    if (used && used[0]) throw new PhotoError(409, 'Esa foto ya está registrada');

    const sortOrder = existing.length ? Math.max(...existing.map(r => r.sort_order || 0)) + 1 : 0;
    const created = await post('media', {
      owner_table: 'products', owner_id: productId, role: 'gallery', bucket: BUCKET, path,
      url: `${publicBase}/${BUCKET}/${path}`, mime_type: String(mimeType).toLowerCase(), sort_order: sortOrder, presentation_id: presentationId,
    });
    const row = Array.isArray(created) ? created[0] : created;
    if (!row) throw new PhotoError(500, 'No se pudo guardar la foto');
    return toApi(row);
  }

  async function remove(productId, presentationId, mediaId) {
    check(productId, presentationId);
    if (!UUID.test(String(mediaId || ''))) throw new PhotoError(404, 'Foto no encontrada');
    const found = await get('media', { id: `eq.${mediaId}`, presentation_id: `eq.${presentationId}`, owner_id: `eq.${productId}`, select: 'id,path,bucket', limit: 1 });
    if (!found || !found[0]) throw new PhotoError(404, 'Foto no encontrada'); // another presentation's or product's photo looks missing
    await deleteRow('media', { id: `eq.${mediaId}` });
    if (found[0].path && found[0].bucket === BUCKET) {
      try { await removeObject(BUCKET, found[0].path); } catch (e) { log.error('[photos] no se pudo borrar el archivo'); }
    }
  }

  return { list, prepareUpload, register, remove };
}

module.exports = { createPresentationPhotos, PhotoError, BUCKET, MAX_PHOTOS, MIME_EXT, pathPattern };
