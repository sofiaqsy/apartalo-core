/**
 * The access check shared by the server routes (17 Nov 2026, phase 1 of closing the routes that worked without a
 * login): a signed-in member of the business, asked to fincas with the person's own Firebase login.
 */
const negociosService = require('../../config/negocios');
const { createClientesAcceso } = require('./clientes-acceso');

module.exports = createClientesAcceso({ getNegocio: id => negociosService.getById(id) });
