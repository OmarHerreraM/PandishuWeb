const warehouses = require('./warehouses.json');

/**
 * Encuentra el almacén óptimo basado en la proximidad del Código Postal
 * @param {string} customerZip - Código postal del cliente
 * @param {Object} ctStockResponse - Objeto de respuesta de la API de CT para GET /existencia/:codigo
 *                 Ejemplo: { "01A": { "existencia": 2774 }, "02A": { "existencia": 0 } }
 * @returns {string|null} - ID del almacén óptimo (Ej. "24A") o null si no hay stock
 */
function getOptimalWarehouse(customerZip, ctStockResponse) {
    if (!ctStockResponse || typeof ctStockResponse !== 'object') return null;

    let bestWarehouse = null;
    let minDistance = Infinity;

    const customerZipNum = parseInt((customerZip || '0').replace(/\D/g, ''), 10) || 0;

    let firstAvailable = null;

    for (const [almacenId, data] of Object.entries(ctStockResponse)) {
        if (!data || data.existencia <= 0) continue;

        if (!firstAvailable) firstAvailable = almacenId;

        const warehouseData = warehouses.find(w => w.id === almacenId);
        if (warehouseData) {
            const whZipNum = parseInt(warehouseData.zipCode, 10);
            const distance = Math.abs(customerZipNum - whZipNum);

            if (distance < minDistance) {
                minDistance = distance;
                bestWarehouse = almacenId;
            }
        }
    }

    return bestWarehouse || firstAvailable;
}

module.exports = { getOptimalWarehouse, warehouses };
