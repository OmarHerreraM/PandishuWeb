/**
 * Pandishú — Skydropx V1 Service
 * 
 * Maneja la autenticación OAuth2 y cotizaciones.
 */

const SKYDROPX_API = 'https://app.skydropx.com/api/v1';
let skydropxToken = null;
let tokenExpiration = 0;

/**
 * Obtiene o renueva el token OAuth de Skydropx.
 * Maneja internamente el cache del token por 2 horas (-5 mins margen).
 */
async function getSkydropxToken() {
    const now = Math.floor(Date.now() / 1000);

    // Si tenemos token y no ha expirado
    if (skydropxToken && now < tokenExpiration) {
        return skydropxToken;
    }

    const clientId = process.env.SKYDROPX_CLIENT_ID;
    const clientSecret = process.env.SKYDROPX_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('SKYDROPX: Faltan credenciales (CLIENT_ID o CLIENT_SECRET)');
    }

    try {
        const urlParams = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        });

        const response = await fetch(`${SKYDROPX_API}/oauth/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: urlParams
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Skydropx Auth Error: ${response.status} - ${err}`);
        }

        const data = await response.json();
        skydropxToken = data.access_token;
        // Restar 300 segundos (5 min) al vencimiento natural para seguridad
        tokenExpiration = now + (data.expires_in || 7200) - 300;

        console.log('📦 [Skydropx] Token renovado exitosamente');
        return skydropxToken;
    } catch (error) {
        console.error('❌ [Skydropx] Error obteniendo token:', error);
        throw error;
    }
}

/**
 * Cotiza envíos en Skydropx.
 * @param {string} destinationZip - CP del cliente
 * @param {Array} parcels - Arreglo de bultos a enviar {weight, height, width, length}
 * @param {string} originZip - CP de origen (Fallback a CP base si es vacio)
 */
async function quoteSkydropxShipment(destinationZip, parcels, originZip = '64000') {
    try {
        const token = await getSkydropxToken();

        // Estructura V1 Quotation request
        const payload = {
            quotation: {
                address_from: {
                    country_code: 'MX',
                    postal_code: originZip,
                    area_level1: 'Nuevo León', // Valores genéricos mínimos necesarios u obtenidos del zip
                    area_level2: 'Monterrey',
                    area_level3: 'Centro'
                },
                address_to: {
                    country_code: 'MX',
                    postal_code: destinationZip,
                    area_level1: 'MX', // Se requiere llenar con datos validos o mock, la API usualmente valida ZIP+Country
                    area_level2: 'Ciudad',
                    area_level3: 'Colonia'
                },
                parcels: parcels.map(p => ({
                    length: p.length || 10,
                    width: p.width || 10,
                    height: p.height || 10,
                    weight: p.weight || 1
                }))
            }
        };

        const response = await fetch(`${SKYDROPX_API}/quotations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errData = await response.json();
            console.error('❌ [Skydropx] Error en cotización HTTP:', response.status, errData);
            return null;
        }

        const data = await response.json();

        if (data.rates && data.rates.length > 0) {
            // Filtrar tarifas validas y ordenar por precio total ascendente
            const validRates = data.rates.filter(r => r.amount && parseFloat(r.total) > 0);
            validRates.sort((a, b) => parseFloat(a.total) - parseFloat(b.total));
            return validRates;
        }

        return null; // Sin tarifas

    } catch (e) {
        console.error('❌ [Skydropx] Excepción al cotizar:', e);
        return null;
    }
}

module.exports = {
    getSkydropxToken,
    quoteSkydropxShipment
};
