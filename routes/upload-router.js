/**
 * APARTALO CORE - Upload Routes
 * 
 * Endpoints para subir archivos a Google Drive
 * Soporta imágenes de productos, vouchers, etc.
 */

const express = require('express');
const router = express.Router();
const DriveService = require('../core/services/drive-service');

// Instancia del servicio de Drive
const driveService = new DriveService();

/**
 * POST /api/upload/:businessId
 * 
 * Subir imagen a Google Drive
 * Body: multipart/form-data con campo 'image' o JSON con base64
 * 
 * Soporta:
 * 1. multipart/form-data (archivo directo)
 * 2. application/json con { image: 'base64...' }
 */
router.post('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const contentType = req.headers['content-type'] || '';

    let fileBuffer;
    let fileName;
    let mimeType;

    // Opción 1: JSON con base64
    if (contentType.includes('application/json')) {
      const { image, filename, type } = req.body;

      if (!image) {
        return res.status(400).json({ error: 'Campo requerido: image (base64)' });
      }

      // Decodificar base64
      // Formato esperado: "data:image/jpeg;base64,/9j/4AAQ..." o solo el base64
      let base64Data = image;
      
      if (image.includes('base64,')) {
        const parts = image.split('base64,');
        base64Data = parts[1];
        
        // Extraer mimeType del prefijo
        const mimeMatch = parts[0].match(/data:([^;]+);/);
        mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      } else {
        mimeType = type || 'image/jpeg';
      }

      fileBuffer = Buffer.from(base64Data, 'base64');
      fileName = filename || `producto_${Date.now()}.jpg`;

    } 
    // Opción 2: Raw binary
    else if (contentType.includes('image/')) {
      const chunks = [];
      
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      
      fileBuffer = Buffer.concat(chunks);
      mimeType = contentType.split(';')[0];
      fileName = `producto_${Date.now()}.${mimeType.split('/')[1] || 'jpg'}`;
    }
    // Opción 3: Multipart (requiere body-parser específico)
    else {
      // Si llegó como form-data procesado por un middleware
      if (req.file) {
        fileBuffer = req.file.buffer;
        fileName = req.file.originalname || `producto_${Date.now()}.jpg`;
        mimeType = req.file.mimetype || 'image/jpeg';
      } else if (req.body && req.body.image) {
        // Fallback: intentar como base64 en form-urlencoded
        const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
        fileBuffer = Buffer.from(base64Data, 'base64');
        mimeType = 'image/jpeg';
        fileName = `producto_${Date.now()}.jpg`;
      } else {
        return res.status(400).json({ 
          error: 'No se encontró imagen',
          hint: 'Envía como JSON { image: "base64..." } o como binary con Content-Type image/*'
        });
      }
    }

    // Validar tamaño (max 10MB)
    if (fileBuffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Imagen muy grande (max 10MB)' });
    }

    // Validar tipo
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(mimeType)) {
      return res.status(400).json({ 
        error: 'Tipo de archivo no permitido',
        allowedTypes 
      });
    }

    // Subir a Google Drive
    const result = await driveService.uploadImage(
      fileBuffer,
      fileName,
      mimeType,
      businessId
    );

    res.json({
      success: true,
      url: result.url,
      fileId: result.fileId,
      name: result.name
    });

  } catch (error) {
    console.error('❌ Error en upload:', error);
    res.status(500).json({ 
      error: 'Error subiendo imagen',
      details: error.message 
    });
  }
});

/**
 * GET /api/upload/:businessId
 * 
 * Listar imágenes de un negocio
 */
router.get('/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { limit } = req.query;

    const files = await driveService.listFiles(
      businessId, 
      parseInt(limit) || 50
    );

    res.json({
      total: files.length,
      files
    });

  } catch (error) {
    console.error('❌ Error listando archivos:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/upload/:businessId/:fileId
 * 
 * Eliminar imagen
 */
router.delete('/:businessId/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    const deleted = await driveService.deleteFile(fileId);

    res.json({
      success: deleted,
      fileId
    });

  } catch (error) {
    console.error('❌ Error eliminando archivo:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
