/**
 * OCR Router
 * Extrae el número de operación de imágenes de comprobantes BCP.
 * Usado por la extensión Chrome BCP → Apartalo.
 */

const express = require('express');
const router = express.Router();
const { createWorker } = require('tesseract.js');
const axios = require('axios');

// Cache en memoria: imageUrl → operacion (evita OCR repetido)
const ocrCache = new Map();

/**
 * GET /api/ocr/voucher?url=<image_url>
 * Retorna el número de operación BCP extraído de la imagen.
 */
router.get('/voucher', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta parámetro url' });

  // Retornar desde cache si ya fue procesada
  if (ocrCache.has(url)) {
    return res.json({ operacion: ocrCache.get(url), cached: true });
  }

  try {
    // Convertir drive.google.com/uc?export=view&id=X
    // → drive.usercontent.google.com/download?id=X&export=view (accesible sin auth)
    let imageUrl = url;
    const driveMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (driveMatch && url.includes('drive.google.com')) {
      imageUrl = `https://drive.usercontent.google.com/download?id=${driveMatch[1]}&export=view`;
    }

    // Descargar imagen siguiendo redirecciones
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*'
      }
    });

    // Verificar que sea una imagen real (no una página HTML de error)
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      console.log(`⚠️ OCR: URL devolvió HTML (posible auth requerida): ${imageUrl}`);
      return res.json({ operacion: null });
    }

    const imageBuffer = Buffer.from(response.data);

    // OCR con Tesseract
    const worker = await createWorker('spa');
    const { data: { text } } = await worker.recognize(imageBuffer);
    await worker.terminate();

    // Extraer número de operación BCP: "Número de operación 01493164"
    const match = text.match(/[Nn][°o]?\s*\.?\s*(?:de\s+)?operaci[oó]n[:\s]+(\d{6,10})/i)
               || text.match(/operaci[oó]n[^0-9]*(\d{6,10})/i)
               || text.match(/\b(\d{8})\b/);

    const operacion = match ? match[1].trim() : null;

    if (operacion) ocrCache.set(url, operacion);

    console.log(`🔍 OCR voucher → Op: ${operacion || 'no encontrado'}`);
    res.json({ operacion });

  } catch (error) {
    console.error('❌ OCR error:', error.message);
    res.status(500).json({ error: error.message, operacion: null });
  }
});

/**
 * GET /api/ocr/image?url=<drive_url>
 * Proxy para cargar imágenes de Google Drive desde la extensión Chrome.
 */
router.get('/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  let imageUrl = url;
  const driveMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (driveMatch && url.includes('drive.google.com')) {
    imageUrl = `https://drive.usercontent.google.com/download?id=${driveMatch[1]}&export=view`;
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*'
      }
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(response.data));
  } catch (e) {
    res.status(502).end();
  }
});

module.exports = router;
