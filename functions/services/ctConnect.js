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

module.exports = { generateCTToken, getCTItemStock };
