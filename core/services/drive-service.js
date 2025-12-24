/**
 * APARTALO CORE - Google Drive Service
 * 
 * Servicio para subir archivos a Google Drive
 * - Comprobantes de pago
 * - Imágenes de productos
 */

const { google } = require('googleapis');
const config = require('../../config');

class DriveService {
  constructor() {
    this.drive = null;
    this.auth = null;
    this.initialized = false;
    this.defaultFolderId = config.google.driveFolderId;
  }

  /**
   * Inicializar conexión con Google Drive
   */
  async initialize() {
    try {
      if (!config.google.serviceAccountKey) {
        console.log('⚠️ Google Drive no configurado');
        return false;
      }

      const credentials = JSON.parse(config.google.serviceAccountKey);

      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });

      this.drive = google.drive({ version: 'v3', auth: this.auth });
      this.initialized = true;

      console.log('✅ DriveService inicializado');
      return true;
    } catch (error) {
      console.error('❌ Error inicializando Drive:', error.message);
      return false;
    }
  }

  /**
   * Subir archivo a Drive
   * @param {Buffer} fileBuffer - Contenido del archivo
   * @param {string} fileName - Nombre del archivo
   * @param {string} mimeType - Tipo MIME
   * @param {string} folderId - Carpeta destino (opcional)
   */
  async uploadFile(fileBuffer, fileName, mimeType, folderId = null) {
    if (!this.initialized) {
      console.log('⚠️ Drive no inicializado');
      return null;
    }

    try {
      const { Readable } = require('stream');
      const stream = Readable.from(fileBuffer);

      const fileMetadata = {
        name: fileName,
        parents: [folderId || this.defaultFolderId]
      };

      const media = {
        mimeType,
        body: stream
      };

      const response = await this.drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id, webViewLink, webContentLink'
      });

      // Hacer público el archivo
      await this.drive.permissions.create({
        fileId: response.data.id,
        resource: {
          role: 'reader',
          type: 'anyone'
        }
      });

      console.log(`✅ Archivo subido: ${fileName}`);

      return {
        id: response.data.id,
        viewLink: response.data.webViewLink,
        downloadLink: response.data.webContentLink,
        directLink: `https://drive.google.com/uc?export=view&id=${response.data.id}`
      };
    } catch (error) {
      console.error('❌ Error subiendo archivo:', error.message);
      return null;
    }
  }

  /**
   * Subir imagen desde base64
   */
  async uploadBase64Image(base64Data, fileName, folderId = null) {
    // Remover prefijo data:image/...;base64,
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');

    // Detectar tipo de imagen
    let mimeType = 'image/jpeg';
    if (base64Data.includes('image/png')) mimeType = 'image/png';
    if (base64Data.includes('image/gif')) mimeType = 'image/gif';
    if (base64Data.includes('image/webp')) mimeType = 'image/webp';

    return await this.uploadFile(buffer, fileName, mimeType, folderId);
  }

  /**
   * Crear carpeta en Drive
   */
  async createFolder(folderName, parentId = null) {
    if (!this.initialized) return null;

    try {
      const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [this.defaultFolderId]
      };

      const response = await this.drive.files.create({
        resource: fileMetadata,
        fields: 'id'
      });

      console.log(`✅ Carpeta creada: ${folderName}`);
      return response.data.id;
    } catch (error) {
      console.error('❌ Error creando carpeta:', error.message);
      return null;
    }
  }

  /**
   * Obtener o crear carpeta para un negocio
   */
  async getOrCreateBusinessFolder(businessId, businessName) {
    if (!this.initialized) return this.defaultFolderId;

    try {
      // Buscar si existe
      const response = await this.drive.files.list({
        q: `name='${businessName}' and mimeType='application/vnd.google-apps.folder' and '${this.defaultFolderId}' in parents`,
        fields: 'files(id, name)'
      });

      if (response.data.files.length > 0) {
        return response.data.files[0].id;
      }

      // Crear nueva
      return await this.createFolder(businessName);
    } catch (error) {
      console.error('❌ Error obteniendo carpeta:', error.message);
      return this.defaultFolderId;
    }
  }
}

module.exports = new DriveService();
