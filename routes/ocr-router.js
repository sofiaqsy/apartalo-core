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
    // Descargar imagen
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
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

module.exports = router;
