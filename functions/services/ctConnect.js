const axios = require('axios');

/**
 * Servicio de Autenticación CT Connect
 * Se encarga de solicitar nuevos Bearer Tokens usando las credenciales estáticas.
 * Documentación: https://api.ctonline.mx/documentacion.html#tag/Autenticacion/operation/token
 */
async function generateCTToken() {
    try {
        const ctEmail = process.env.CT_EMAIL;
        const ctCliente = process.env.CT_CLIENT_ID;
        const ctRfc = process.env.CT_RFC;
        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';

        if (!ctEmail || !ctCliente || !ctRfc) {
            console.error('[CT Connect] Faltan credenciales en las variables de entorno (.env). No se puede autenticar.');
            return null;
        }

        console.log('[CT Connect] Solicitando nuevo token CTONLINE...');

        const payload = {
            email: ctEmail,
            cliente: ctCliente,
            rfc: ctRfc
        };

        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        // Usa la variable de entorno PROXY_URL (ej. http://user:pass@ip:port) para evitar exponer credenciales
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

        const response = await axios.post(`${baseUrl}/cliente/token`, payload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000, // 10 segundos timeout
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });

        if (response.data && response.data.token) {
            console.log(`[CT Connect] ¡Token generado exitosamente! Expira en approx 24h.`);
            return response.data.token;
        } else {
            console.error('[CT Connect] Error inesperado en el payload de respuesta:', response.data);
            return null;
        }

    } catch (error) {
        console.error('[CT Connect - ERROR DE AUTENTICACIÓN]');
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data:`, error.response.data);
        } else {
            console.error(error.message);
        }
        return null;
    }
}

async function getCTItemStock(codigo, token) {
    try {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        // Usa la variable de entorno PROXY_URL (ej. http://user:pass@ip:port) para evitar exponer credenciales
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';
        const response = await axios.get(`${baseUrl}/existencia/${codigo}`, {
            headers: { 'x-auth': token },
            timeout: 15000,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error) {
        console.error(`[CT Connect] Error fetching stock for ${codigo}:`, error.message);
        return null;
    }
}
async function createCTOrder(orderPayload, token) {
    try {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';

        console.log(`[CT Connect] Creando orden de compra... Payload:`, JSON.stringify(orderPayload));
        const response = await axios.post(`${baseUrl}/pedido`, orderPayload, {
            headers: {
                'x-auth': token,
                'Content-Type': 'application/json'
            },
            timeout: 25000,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });

        console.log(`[CT Connect] Respuesta creacion pedido:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`[CT Connect] Error creando orden CT:`);
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data:`, error.response.data);
            return error.response.data; // Retornamos para poder ver el error en el log de compras
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

async function confirmCTOrder(folio, token) {
    try {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';

        const payload = { folio };
        console.log(`[CT Connect] Confirmando pedido CT Folio: ${folio}`);
        const response = await axios.post(`${baseUrl}/pedido/confirmar`, payload, {
            headers: {
                'x-auth': token,
                'Content-Type': 'application/json'
            },
            timeout: 15000,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });

        console.log(`[CT Connect] Respuesta confirmando pedido:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`[CT Connect] Error confirmando pedido CT:`);
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data:`, error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

async function getCTFreight({ items, destinoCP, almacen, token }) {
    try {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';

        // CT /fletes expects: { almacen, cp, partidas: [{clave, cantidad, precio}] }
        const payload = {
            almacen: almacen || '01A',
            cp: parseInt((destinoCP || '06000').replace(/\D/g, ''), 10),
            partidas: items.map(i => ({
                clave: i.sku || i.clave,
                cantidad: parseInt(i.quantity || i.cantidad || 1),
                precio: parseFloat(i.price || i.precio || 0)
            }))
        };

        console.log('[CT Freight] Requesting freight quote:', JSON.stringify(payload));

        const response = await axios.post(`${baseUrl}/fletes`, payload, {
            headers: {
                'x-auth': token,
                'Content-Type': 'application/json'
            },
            timeout: 15000,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });

        console.log('[CT Freight] Response:', response.data);
        // CT returns { total, costo, guia, empresa } or similar
        const cost = response.data?.total || response.data?.costo || response.data?.flete || 0;
        return {
            costMXN: parseFloat(cost) || 0,
            carrier: response.data?.empresa || 'CT DropShipping',
            raw: response.data
        };

    } catch (error) {
        console.error('[CT Freight] Error fetching freight quote:', error.response?.data || error.message);
        // On error, return a safe fallback (0 to not block checkout)
        return { costMXN: 0, carrier: 'CT DropShipping', error: error.message };
    }
}

async function getCTVolumetry(codigo, token) {
    try {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';

        const response = await axios.get(`${baseUrl}/paqueteria/volumetria/${codigo}`, {
            headers: { 'x-auth': token },
            timeout: 10000,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });
        // Returns: { peso, largo, alto, ancho, UPC, EAN }
        return response.data;
    } catch (error) {
        console.error(`[CT Volumetry] Error for SKU ${codigo}:`, error.response?.data || error.message);
        return null;
    }
}

/**
 * Subir guía de SkydropX a CT para que procesen el envío.
 * POST /pedido/guias
 * @param {string} pedidoWeb - CT order folio (e.g. "W01-000001")
 * @param {string} trackingNumber - SkydropX tracking number
 * @param {string} paqueteria - Carrier name (e.g. "estafeta", "fedex")
 * @param {string} labelBase64 - Optional base64-encoded PDF label
 * @param {string} token - CT auth token
 */
async function uploadLabelToCT(pedidoWeb, trackingNumber, paqueteria, labelBase64, token) {
    try {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        const proxyUrl = process.env.PROXY_URL;
        const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
        const baseUrl = process.env.CT_API_CONNECT || 'http://connect.ctonline.mx:3001';

        const payload = {
            folio: pedidoWeb,
            guias: [{
                guia: trackingNumber,
                paqueteria: (paqueteria || 'estafeta').toLowerCase(),
                archivo: labelBase64 || ''
            }]
        };

        console.log(`[CT Guias] Uploading label for folio ${pedidoWeb}:`, JSON.stringify(payload));

        const response = await axios.post(`${baseUrl}/pedido/guias`, payload, {
            headers: { 'x-auth': token, 'Content-Type': 'application/json' },
            timeout: 15000,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });

        console.log(`[CT Guias] Response:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`[CT Guias] Error uploading label for ${pedidoWeb}:`, error.response?.data || error.message);
        return null;
    }
}

module.exports = { generateCTToken, getCTItemStock, createCTOrder, confirmCTOrder, getCTFreight, getCTVolumetry, uploadLabelToCT };


