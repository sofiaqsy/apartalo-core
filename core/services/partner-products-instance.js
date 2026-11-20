/** Wires the partner products router to the real services (Firebase, fincas, storage). */
const axios = require('axios');
const supabaseService = require('./supabase-service');
const firebaseService = require('./firebase-service');
const negociosService = require('../../config/negocios');
const { createIdentityService } = require('./identity-service');
const { createPresentationPhotos } = require('./presentation-photos');
const { createPartnerProductsRouter } = require('../../routes/partner-products-router');

const storageBase = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '') + '/storage/v1';
const storageHeaders = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });

function buildPartnerProductsRouter() {
  const identity = createIdentityService({
    get: supabaseService.get, post: supabaseService.post, patch: supabaseService.patch,
    getNegocios: () => negociosService.getAll(), refreshNegocios: () => negociosService.loadFromFarms(),
  });
  const photos = createPresentationPhotos({
    get: supabaseService.get, post: supabaseService.post, deleteRow: supabaseService.deleteRow,
    publicBase: `${storageBase()}/object/public`,
    signUpload: async (bucket, path) => {
      const r = await axios.post(`${storageBase()}/object/upload/sign/${bucket}/${path}`, {}, { headers: storageHeaders() });
      const raw = r.data.signedURL || r.data.url || r.data.signedUrl;
      if (!raw) throw new Error('Storage did not return the signed URL');
      return raw.startsWith('http') ? raw : `${storageBase()}${raw}`;
    },
    removeObject: (bucket, path) => axios.delete(`${storageBase()}/object/${bucket}/${path}`, { headers: storageHeaders() }),
  });
  return createPartnerProductsRouter({
    verifyToken: t => firebaseService.verifyIdToken(t),
    resolveSession: id => identity.resolveSession(id),
    photos,
    products: {
      list: farmId => supabaseService.getProductsWithPresentations(farmId),
      getById: id => supabaseService.getProductById(id),
      create: (farmId, p) => supabaseService.createProduct(farmId, p),
      update: (id, f) => supabaseService.updateProduct(id, f),
      getPresentation: async id => {
        const rows = await supabaseService.get('product_presentations', { id: `eq.${id}`, select: 'id,product_id,pack_size,unit,price_cents,stock,is_visible,is_default', limit: 1 });
        return rows && rows[0] ? rows[0] : null;
      },
      createPresentation: (productId, p) => supabaseService.createPresentation(productId, p),
      updatePresentation: (id, f) => supabaseService.updatePresentation(id, f),
    },
  });
}

module.exports = { buildPartnerProductsRouter };
