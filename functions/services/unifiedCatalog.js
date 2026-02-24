/**
 * Pandishú — Unified Product Mapper
 * 
 * Este servicio normaliza la data de Ingram (CSV) y CT (API) 
 * hacia el esquema de base de datos unificado de Pandishú.
 */

/**
 * Transforma un objeto de producto de CT al formato estándar.
 */
function mapCTToPandishu(ctProduct) {
    return {
        id: `CT-${ctProduct.codigo}`,
        sku: ctProduct.codigo,
        mpn: ctProduct.numParte,
        brand: ctProduct.marca,
        name: ctProduct.nombre,
        description: ctProduct.descripcion,
        image_url: ctProduct.imagen,
        cost_price: parseFloat(ctProduct.precio),
        currency: ctProduct.moneda || 'USD',
        provider: 'CT'
    };
}

/**
 * Transforma una fila de CSV de Ingram al formato estándar.
 * (Nota: Los índices de las columnas dependen del archivo real de Ingram)
 */
function mapIngramToPandishu(csvRow) {
    // Ejemplo basado en estructura típica de Ingram
    return {
        id: `IM-${csvRow.sku}`,
        sku: csvRow.sku,
        mpn: csvRow.mpn,
        brand: csvRow.brand || 'Desconocido',
        name: csvRow.description,
        description: csvRow.extended_description || csvRow.description,
        image_url: csvRow.image_url || '',
        cost_price: parseFloat(csvRow.cost),
        currency: 'MXN', // Ingram México suele cotizar en MXN en sus archivos
        provider: 'Ingram'
    };
}

/**
 * Lógica de Fulfillment Dividido
 * 
 * @param {Array} cartItems 
 * @param {string} ctCarrierOptionStr - Ej: 'Estafeta' o 'DHL' (obtenido en Cotización)
 */
function routeOrderItems(cartItems, ctCarrierOptionStr = 'Estafeta') {
    const routing = {
        ct: [],
        ingram: [],
        ctPayload: null // Guardaremos el objeto JSON final para CT aquí
    };

    const masterOrderId = `PAN-${Date.now()}`;

    cartItems.forEach(item => {
        if (item.id.startsWith('CT-')) {
            routing.ct.push(item);
        } else {
            routing.ingram.push(item);
        }
    });

    // Construcción del Payload Avanzado de CT Connect
    if (routing.ct.length > 0) {
        routing.ctPayload = {
            idPedido: `${masterOrderId}-CT`,
            terminoPago: "00", // Crédito o Prepago según tu cuenta
            cfdi: "G01",       // Gastos en general
            generarGuia: true, // NUEVO REQUISITO: Que CT genere y cobre la guía
            guiaConnect: {
                paqueteria: ctCarrierOptionStr
            },
            partidas: routing.ct.map(p => ({
                cantidad: p.quantity,
                claveArticulo: p.id.replace('CT-', ''),
                precio: p.vendorCost
            }))
        };
    }

    return routing;
}

/**
 * Consulta detallada de una Guía de CT ya despachada.
 * GET /paqueteria/detalles/guia/:folio
 * 
 * @param {string} folio - Número de folio de la orden en CT
 * @param {string} ctToken - Token x-auth
 */
async function getCTTrackingInfo(folio, ctToken) {
    console.log(`🔎 Consultando Tracking CT para el folio: ${folio}`);
    try {
        const url = `http://connect.ctonline.mx:3001/paqueteria/detalles/guia/${folio}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'x-auth': ctToken }
        });

        if (!response.ok) {
            throw new Error(`Error recuperando guía: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data; // Contiene info de paquetería y número de rastreo real
    } catch (err) {
        console.error('❌ Error fetching CT Tracking Info:', err.message);
        return null; // Return null para que el proceso que lo llame no explote
    }
}

module.exports = {
    mapCTToPandishu,
    mapIngramToPandishu,
    routeOrderItems,
    getCTTrackingInfo
};
