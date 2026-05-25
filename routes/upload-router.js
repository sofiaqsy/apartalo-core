/**
 * APARTALO CORE - Upload Routes
 *
 * Subida de archivos a Supabase Storage (farm-assets).
 * Reemplaza Google Drive con signed-URL approach para evitar base64 en tránsito.
 *
 * Flujo:
 *  1. POST /:businessId/sign  → valida y devuelve { signedUrl, publicUrl }
 *  2. Cliente sube bytes directamente al signed URL (PUT)
 *  3. Cliente usa publicUrl para mostrar / guardar en la DB
 *
 * Se mantiene POST /:businessId (legacy base64) para compatibilidad con
 * flujos que aún no se han migrado (WhatsApp bot, etc.).
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

// ── helpers Supabase ─────��────────────────────────────────────────────────────
function supabaseBase() {
  return (process.env.SUPABASE_URL || '').replace(/\/$/, '').replace(/\/rest\/v1$/, '');
}
function storageHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

const BUCKET     = 'farm-assets';
const ALLOWED    = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_BYTES  = 10 * 1024 * 1024; // 10 MB

// ── POST /api/upload/:businessId/sign ─────────────────────────────────────────
// Genera URL firmada de Supabase Storage para que el cliente suba directo.
// Body: { filename, mimeType, folder? }
// Returns: { signedUrl, publicUrl, path }
router.post('/:businessId/sign', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { filename, mimeType, folder } = req.body;
    console.log(`[upload/sign] businessId=${businessId} filename=${filename} mimeType=${mimeType} folder=${folder}`);

    if (!filename) return res.status(400).json({ error: 'filename requerido' });

    const mime = mimeType || 'image/jpeg';
    if (!ALLOWED.includes(mime)) {
      return res.status(400).json({ error: 'Tipo no permitido', allowedTypes: ALLOWED });
    }

    const prefix      = folder || `payment-proofs/${businessId}`;
    const storagePath = `${prefix}/${Date.now()}_${filename}`;
    const base        = supabaseBase();

    console.log(`[upload/sign] storagePath=${storagePath}`);
    console.log(`[upload/sign] POST ${base}/storage/v1/object/upload/sign/${BUCKET}/${storagePath}`);

    const signRes = await axios.post(
      `${base}/storage/v1/object/upload/sign/${BUCKET}/${storagePath}`,
      {},
      { headers: storageHeaders() }
    );

    console.log(`[upload/sign] Supabase response status=${signRes.status} data=`, JSON.stringify(signRes.data));

    // Supabase devuelve { url: "/object/upload/sign/farm-assets/...?token=..." }
    // El path es relativo a /storage/v1 — hay que prefijar correctamente.
    const rawPath = signRes.data.signedURL || signRes.data.url || signRes.data.signedUrl;
    if (!rawPath) {
      console.error('[upload/sign] Supabase no retornó signedURL. data:', JSON.stringify(signRes.data));
      return res.status(500).json({ error: 'Supabase no retornó URL firmada', debug: signRes.data });
    }

    // Si ya es URL completa la usamos; si es relativa prefijamos base + /storage/v1
    const signedUrl = rawPath.startsWith('http')
      ? rawPath
      : `${base}/storage/v1${rawPath}`;
    const publicUrl = `${base}/storage/v1/object/public/${BUCKET}/${storagePath}`;

    console.log(`[upload/sign] rawPath=${rawPath}`);

    console.log(`[upload/sign] signedUrl=${signedUrl}`);
    console.log(`[upload/sign] publicUrl=${publicUrl}`);

    res.json({ signedUrl, publicUrl, path: storagePath });
  } catch (error) {
    console.error('❌ [upload/sign] Error:', error.message);
    console.error('❌ [upload/sign] Supabase response:', JSON.stringify(error.response?.data));
    res.status(500).json({ error: 'Error generando URL firmada', details: error.message });
  }
});

// ── POST /api/upload/:businessId (legacy — acepta base64) ─────────────────────
// Mantenido para flujos que aún envían base64 (WhatsApp bot, etc.).
// Sube directamente a Supabase Storage desde el backend.
router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const contentType = req.headers['content-type'] || '';

    let fileBuffer;
    let mimeType;
    let fileName;

    if (contentType.includes('application/json')) {
      const { image, filename, type } = req.body;
      if (!image) return res.status(400).json({ error: 'Campo requerido: image (base64)' });

      let base64Data = image;
      if (image.includes('base64,')) {
        const parts = image.split('base64,');
        base64Data = parts[1];
        const m = parts[0].match(/data:([^;]+);/);
        mimeType = m ? m[1] : 'image/jpeg';
      } else {
        mimeType = type || 'image/jpeg';
      }
      fileBuffer = Buffer.from(base64Data, 'base64');
      fileName   = filename || `upload_${Date.now()}.jpg`;

    } else if (contentType.includes('image/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
      mimeType   = contentType.split(';')[0];
      fileName   = `upload_${Date.now()}.${mimeType.split('/')[1] || 'jpg'}`;

    } else if (req.file) {
      fileBuffer = req.file.buffer;
      fileName   = req.file.originalname || `upload_${Date.now()}.jpg`;
      mimeType   = req.file.mimetype || 'image/jpeg';

    } else {
      return res.status(400).json({ error: 'No se encontró imagen' });
    }

    if (fileBuffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Imagen muy grande (max 10MB)' });
    }
    if (!ALLOWED.includes(mimeType)) {
      return res.status(400).json({ error: 'Tipo no permitido', allowedTypes: ALLOWED });
    }

    const storagePath = `payment-proofs/${businessId}/${Date.now()}_${fileName}`;
    const base        = supabaseBase();
    const key         = process.env.SUPABASE_SERVICE_ROLE_KEY;

    await axios.post(
      `${base}/storage/v1/object/${BUCKET}/${storagePath}`,
      fileBuffer,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': mimeType,
          'x-upsert': 'true',
        },
        maxBodyLength: Infinity,
      }
    );

    const publicUrl = `${base}/storage/v1/object/public/${BUCKET}/${storagePath}`;

    res.json({ success: true, url: publicUrl, path: storagePath });
  } catch (error) {
    console.error('❌ Error en upload (legacy):', error.message, error.response?.data);
    res.status(500).json({ error: 'Error subiendo imagen', details: error.message });
  }
});

// ── DELETE /api/upload/:businessId/:encodedPath ───────────────────────────────
// Eliminar un archivo de Supabase Storage.
// :encodedPath debe ir URL-encoded (el path dentro del bucket).
router.delete('/:businessId/*', async (req, res) => {
  try {
    const storagePath = req.params[0]; // todo lo después de /:businessId/
    if (!storagePath) return res.status(400).json({ error: 'path requerido' });

    const base = supabaseBase();
    const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;

    await axios.delete(
      `${base}/storage/v1/object/${BUCKET}/${storagePath}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );

    res.json({ success: true, path: storagePath });
  } catch (error) {
    console.error('❌ Error eliminando archivo:', error.message);
    res.status(500).json({ error: 'Error eliminando archivo', details: error.message });
  }
});

module.exports = router;
