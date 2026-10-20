/**
 * Ownership guards wired to the real data access.
 * Mode comes from OWNERSHIP_MODE (off | log | block; default off).
 */
const { createOwnership } = require('./ownership');
const supabaseService = require('./supabase-service');
const negociosService = require('../../config/negocios');

module.exports = createOwnership({
  get: supabaseService.get,
  getNegocio: id => negociosService.getById(id),
  mode: process.env.OWNERSHIP_MODE,
});
