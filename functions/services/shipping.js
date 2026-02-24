/**
 * Pandishú — Multi-Warehouse Shipping Service (Updated with CT API)
 * 
 * Calcula el costo de envío total para carritos mixtos.
 * Incorpora la API de paquetería en tiempo real de CT Internacional.
 */

const INGRAM_FLAT_RATE = 149.00; // Tarifa fija Ingram México

/**
 * Calcula el costo de envío basado en el origen de los productos.
 * Regla: Si hay productos de ambos, se suman los envíos individuales.
 * 
 * @param {Array} cartItems - Lista de productos en el carrito
 * @param {string} destinationZip - Código Postal destino
 * @param {string} ctToken - Token de autenticación CT (x-auth)
 */
async function calculateMultiVendorShipping(cartItems, destinationZip, ctToken) {
    let hasIngram = false;
    let ctItems = [];
    let totalShipping = 0;

    let ctShippingData = null;
    let ctAppliedRate = 0;

    // Separar orígenes
    cartItems.forEach(item => {
        if (item.id.startsWith('CT-')) {
            ctItems.push(item);
        } else if (item.id.startsWith('IM-')) {
            hasIngram = true;
        }
    });

    // 1. Tarifa Ingram
    if (hasIngram) {
        totalShipping += INGRAM_FLAT_RATE;
        console.log(`🚚 [Ingram] Aplicando tarifa plana: $${INGRAM_FLAT_RATE} MXN`);
    }

    // 2. Tarifa Dinámica CT Connect (API)
    if (ctItems.length > 0) {
        if (destinationZip && ctToken) {
            console.log(`🚚 [CT API] Solicitando cotización para CP: ${destinationZip}`);
            try {
                // native node fetch
                const response = await fetch('http://connect.ctonline.mx:3001/paqueteria/cotizacion', {
                    method: 'POST',
                    headers: {
                        'x-auth': ctToken,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        destino: destinationZip,
                        productos: ctItems.map(p => ({
                            clave: p.id.replace('CT-', ''),
                            cantidad: p.quantity,
                            almacen: p.almacen || 'DF' // Asumiendo DF como fallback si no se tiene
                        }))
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    ctShippingData = data;

                    // Seleccionar la paquetería (la primera o la más barata si es arreglo)
                    if (Array.isArray(data) && data.length > 0) {
                        ctAppliedRate = data[0].precio || 150.00;
                    } else if (data && data.precio) {
                        ctAppliedRate = data.precio;
                    } else {
                        ctAppliedRate = 150.00; // default safe fallback
                    }
                    console.log(`✅ [CT API] Cotización exitosa: $${ctAppliedRate} MXN`);
                } else {
                    console.error('❌ [CT API] Error cotizando paquetería:', response.status, response.statusText);
                    ctAppliedRate = 150.00;
                }
            } catch (err) {
                console.error('❌ Fetch error CT Paqueteria:', err.message);
                ctAppliedRate = 150.00;
            }
        } else {
            console.log('⚠️ [CT API] Sin CP o Token. Aplicando tarifa fallback $150 MXN');
            ctAppliedRate = 150.00;
        }

        totalShipping += ctAppliedRate;
    }

    return {
        total: totalShipping,
        breakdown: {
            ingram: hasIngram ? INGRAM_FLAT_RATE : 0,
            ct: ctItems.length > 0 ? ctAppliedRate : 0
        },
        splitShipping: (hasIngram && ctItems.length > 0),
        ctShippingOptions: ctShippingData // Devolvemos todas las opciones para que el Front pueda mostrarlas si quiere
    };
}

module.exports = {
    calculateMultiVendorShipping
};
