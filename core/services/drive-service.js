/**
 * APARTALO CORE - Google Drive Service
 * 
 * Servicio para subir imágenes a Google Drive
 * Las imágenes se guardan en una carpeta compartida
 * y se obtiene URL pública para mostrar en la app
 */

const { google } = require('googleapis');
const stream = require('stream');
const config = require('../../config');

class DriveService {
  constructor() {
    this.drive = null;
    this.folderId = config.google.driveFolderId;
  }

  /**
   * Inicializar autenticación con Google Drive
   */
  async initialize() {
    if (this.drive) return;

    try {
      const serviceAccountKey = config.google.serviceAccountKey;
      
      if (!serviceAccountKey) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY no configurado');
      }

      const credentials = JSON.parse(serviceAccountKey);

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });

      this.drive = google.drive({ version: 'v3', auth });
      console.log('✅ Google Drive Service inicializado');
    } catch (error) {
      console.error('❌ Error inicializando Drive:', error.message);
      throw error;
    }
  }

  /**
   * Subir imagen a Google Drive
   * 
   * @param {Buffer} fileBuffer - Buffer de la imagen
   * @param {string} fileName - Nombre del archivo
   * @param {string} mimeType - Tipo MIME (image/jpeg, image/png)
   * @param {string} businessId - ID del negocio (para organizar en carpetas)
   * @returns {object} { fileId, url, name }
   */
  async uploadImage(fileBuffer, fileName, mimeType, businessId = 'general') {
    await this.initialize();

    try {
      // Crear nombre único
      const timestamp = Date.now();
      const uniqueName = `${businessId}_${timestamp}_${fileName}`;

      // Obtener o crear carpeta del negocio
      const folderId = await this.getOrCreateFolder(businessId);

      // Crear stream desde buffer
      const bufferStream = new stream.PassThrough();
      bufferStream.end(fileBuffer);

      // Subir archivo
      const response = await this.drive.files.create({
        requestBody: {
          name: uniqueName,
          mimeType: mimeType,
          parents: [folderId]
        },
        media: {
          mimeType: mimeType,
          body: bufferStream
        },
        fields: 'id, name, webViewLink, webContentLink'
      });

      const fileId = response.data.id;

      // Hacer el archivo público
      await this.drive.permissions.create({
        fileId: fileId,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });

      // Obtener URL pública directa
      const publicUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

      console.log(`✅ Imagen subida: ${uniqueName}`);

      return {
        fileId: fileId,
        url: publicUrl,
        name: uniqueName,
        webViewLink: response.data.webViewLink
      };

    } catch (error) {
      console.error('❌ Error subiendo imagen:', error.message);
      throw error;
    }
  }

  /**
   * Obtener o crear carpeta para un negocio
   */
  async getOrCreateFolder(businessId) {
    await this.initialize();

    // Si no hay carpeta raíz configurada, usar la raíz de Drive
    const parentId = this.folderId || 'root';

    try {
      // Buscar si ya existe la carpeta
      const searchResponse = await this.drive.files.list({
        q: `name='${businessId}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: 'files(id, name)'
      });

      if (searchResponse.data.files.length > 0) {
        return searchResponse.data.files[0].id;
      }

      // Crear carpeta nueva
      const folderResponse = await this.drive.files.create({
        requestBody: {
          name: businessId,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId]
        },
        fields: 'id'
      });

      console.log(`📁 Carpeta creada para negocio: ${businessId}`);
      return folderResponse.data.id;

    } catch (error) {
      console.error('❌ Error con carpeta:', error.message);
      // Si falla, usar carpeta raíz
      return parentId;
    }
  }

  /**
   * Eliminar archivo de Drive
   */
  async deleteFile(fileId) {
    await this.initialize();

    try {
      await this.drive.files.delete({ fileId });
      console.log(`🗑️ Archivo eliminado: ${fileId}`);
      return true;
    } catch (error) {
      console.error('❌ Error eliminando archivo:', error.message);
      return false;
    }
  }

  /**
   * Listar archivos de un negocio
   */
  async listFiles(businessId, limit = 50) {
    await this.initialize();

    try {
      const folderId = await this.getOrCreateFolder(businessId);

      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, createdTime, size)',
        pageSize: limit,
        orderBy: 'createdTime desc'
      });

      return response.data.files.map(file => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        createdAt: file.createdTime,
        size: file.size,
        url: `https://drive.google.com/uc?export=view&id=${file.id}`
      }));

    } catch (error) {
      console.error('❌ Error listando archivos:', error.message);
      return [];
    }
  }
}

module.exports = DriveService;
