'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');

admin.initializeApp();

// ─── CREDENTIALS (from functions/.env) ──────────────────────────────────────
const IM_CLIENT_ID = process.env.INGRAM_CLIENT_ID;
const IM_CLIENT_SECRET = process.env.INGRAM_CLIENT_SECRET;
const IM_SECRET_KEY = process.env.INGRAM_SECRET_KEY;
const IM_CUSTOMER_NUM = process.env.INGRAM_CUSTOMER_NUMBER || 'SBX';
const IM_COUNTRY_CODE = process.env.INGRAM_COUNTRY_CODE || 'US';

// ─── TOKEN CACHE ─────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

/**
 * Obtiene (o reutiliza si no venció) el OAuth2 Bearer token de Ingram Micro.
 */
async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    console.log('Fetching new access token with Client ID:', IM_CLIENT_ID ? 'Present' : 'MISSING');

    return new Promise((resolve, reject) => {
        const api = new XiSdk.AccesstokenApi();
        api.getAccesstoken('client_credentials', IM_CLIENT_ID, IM_CLIENT_SECRET,
            (err, data) => {
                if (err) {
                    console.error('getAccesstoken raw error:', err);
                    return reject(new Error(`Auth error: ${err.message || err}`));
                }
                console.log('Token obtained successfully');
                cachedToken = data.access_token;
                // Cache por 55 minutos (token dura 60 min)
                tokenExpiry = Date.now() + 55 * 60 * 1000;
                resolve(cachedToken);
            }
        );
    });
}

/**
 * Crea y configura el ApiClient del SDK con el token activo.
 */
async function getApiClient() {
    const token = await getAccessToken();
    const client = XiSdk.ApiClient.instance;

    // Configurar explícitamente la URL de Sandbox
    client.basePath = 'https://api.ingrammicro.com:443/sandbox';

    // OAuth2
    const auth = client.authentications['application'];
    auth.accessToken = token;

    // Headers comunes de Ingram
    client.defaultHeaders = {
        'IM-CustomerNumber': IM_CUSTOMER_NUM,
        'IM-CountryCode': IM_COUNTRY_CODE,
        'IM-SenderID': 'Pandishu',
        'IM-SecretKey': IM_SECRET_KEY, // Requerido para algunas operaciones de catálogo v6
    };

    return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — searchProducts
// GET /resellers/v6/catalog?keyword=...
// Llamado desde tienda.html
// ─────────────────────────────────────────────────────────────────────────────
exports.searchProducts = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        try {
            await getApiClient();

            const api = new XiSdk.ProductCatalogApi();
            const opts = {
                keyword: req.query.keyword ? [req.query.keyword] : undefined,
                vendor: req.query.vendor ? [req.query.vendor] : undefined,
                pageNumber: parseInt(req.query.pageNumber) || 1,
                pageSize: Math.min(parseInt(req.query.pageSize) || 24, 100),
            };

            const correlationId = `pandishu-search-${Date.now()}`;

            const data = await new Promise((resolve, reject) => {
                api.getResellerV6Productsearch(
                    IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId,
                    opts,
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            return res.status(200).json(data);
        } catch (err) {
            console.error('searchProducts full error:', JSON.stringify(err, null, 2));
            console.error('searchProducts message:', err.message || err);
            return res.status(500).json({
                error: err.message || 'Internal error',
                details: err.response?.body || err.response || null
            });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — getPriceAndAvailability
// POST body: { skus: ["SKU1", "SKU2"] }  (máx 50)
// ─────────────────────────────────────────────────────────────────────────────
exports.getPriceAndAvailability = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const { skus } = req.body;
        if (!Array.isArray(skus) || skus.length === 0) {
            return res.status(400).json({ error: 'Se requiere el array skus' });
        }
        if (skus.length > 50) {
            return res.status(400).json({ error: 'Máximo 50 SKUs por petición' });
        }

        try {
            await getApiClient();

            const api = new XiSdk.ProductCatalogApi();
            const body = XiSdk.PriceAndAvailabilityRequest.constructFromObject({
                products: skus.map(sku => ({ ingramPartNumber: sku })),
            });

            const correlationId = `pandishu-pa-${Date.now()}`;

            const data = await new Promise((resolve, reject) => {
                api.postPriceandavailability(
                    IM_CUSTOMER_NUM, IM_COUNTRY_CODE, correlationId,
                    true, true,   // includeAvailability, includePricing
                    { priceAndAvailabilityRequest: body },
                    (err, result) => err ? reject(err) : resolve(result)
                );
            });

            return res.status(200).json(data);
        } catch (err) {
            console.error('getPriceAndAvailability error:', err.message || err);
            return res.status(500).json({ error: err.message || 'Internal error' });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — ingramWebhook
// POST — Ingram Micro envía eventos aquí (OrderStatus, StockUpdate, etc.)
// ESTA URL es la que registras en el portal de Ingram como Destination URL
// ─────────────────────────────────────────────────────────────────────────────
exports.ingramWebhook = functions.https.onRequest(async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const signature = req.headers['x-hub-signature'] || req.headers['authorization'] || '';
        if (IM_SECRET_KEY && signature && !signature.includes(IM_SECRET_KEY)) {
            console.warn('[Ingram Webhook] Signature mismatch — logging anyway (sandbox)');
        }

        const event = req.body;
        console.log('[Ingram Webhook] Event:', JSON.stringify(event, null, 2));

        // Guardar en Firestore para debugging
        await admin.firestore().collection('ingram_events').add({
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            eventType: event.topic || event.eventType || 'unknown',
            rawPayload: event,
        });

        return res.status(200).json({ status: 'received' });
    } catch (err) {
        console.error('[Ingram Webhook] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─── PAYMENTS: MERCADO PAGO INTEGRATION ──────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const { MercadoPagoConfig, Preference } = require('mercadopago');

const getMercadoPagoClient = () => {
    if (!process.env.MP_ACCESS_TOKEN) {
        console.warn("Missing MP_ACCESS_TOKEN env variable");
        return null;
    }
    // Set up MercadoPago client
    return new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
};

const YOUR_DOMAIN = 'https://pandishu-web-1d860.web.app'; // Production URL

/**
 * FUNCTION 4 — createCheckoutSession
 * POST body: { items: [...], customer: {...} }
 * Crea una preferencia de pago en Mercado Pago y devuelve el init_point para redirigir al usuario.
 */
exports.createCheckoutSession = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const client = getMercadoPagoClient();
        if (!client) return res.status(500).json({ error: 'Mercado Pago is not configured in environment variables' });

        try {
            const { items, customer } = req.body;

            if (!items || items.length === 0) {
                return res.status(400).json({ error: 'El carrito está vacío' });
            }

            // Mapear los items del carrito a la estructura de Mercado Pago
            const preferenceItems = items.map(item => {
                return {
                    id: item.sku,
                    title: item.name,
                    description: `Vendor: ${item.vendor}`, // MP allows description
                    quantity: item.quantity,
                    currency_id: 'USD',
                    unit_price: Number(item.price)
                };
            });

            // Metadata must be serialized as external_reference or saved before/after
            // We use external_reference as a unique ID to link back to Firestore
            // Let's create an order document IN ADVANCE with status "pending"

            const orderRef = await admin.firestore().collection('orders').add({
                status: 'pending_payment',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                customerInfo: customer,
                items: items,
                ingramStatus: 'pending',
                amountTotal: items.reduce((sum, item) => sum + (item.price * item.quantity), 0)
            });

            // Crear la preferencia usando la nueva sintaxis (v2)
            const preference = new Preference(client);

            const prefResponse = await preference.create({
                body: {
                    items: preferenceItems,
                    payer: {
                        name: customer.name,
                        email: customer.email,
                        phone: { number: customer.phone },
                        address: {
                            zip_code: customer.address.zip,
                            street_name: customer.address.street,
                        }
                    },
                    back_urls: {
                        success: `${YOUR_DOMAIN}/order-confirmation.html`,
                        failure: `${YOUR_DOMAIN}/checkout.html?error=failed`,
                        pending: `${YOUR_DOMAIN}/order-confirmation.html?status=pending`
                    },
                    auto_return: 'approved',
                    external_reference: orderRef.id, // Vínculo con nuestra BD
                    statement_descriptor: 'Pandishu Tech',
                    // Redirigir notificaciones de pago aquí
                    notification_url: 'https://us-central1-pandishu-web-1d860.cloudfunctions.net/mpWebhook'
                }
            });

            // Retornamos el init_point (o sandbox_init_point si estamos en dev)
            return res.status(200).json({ url: prefResponse.init_point });

        } catch (err) {
            console.error('Error createCheckoutSession MP:', err);
            return res.status(500).json({ error: err.message });
        }
    });
});

/**
 * FUNCTION 5 — mpWebhook
 * Webhook de Mercado Pago para notificaciones IPN/Webhooks
 */
exports.mpWebhook = functions.https.onRequest(async (req, res) => {
    const client = getMercadoPagoClient();
    if (!client) return res.status(500).send('MP is not configured');

    const topic = req.query.topic || req.body.type;
    const paymentId = req.query.id || (req.body.data && req.body.data.id);

    // Validar firma x-signature de Mercado Pago
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    const secret = process.env.MP_WEBHOOK_SECRET;

    if (xSignature && xRequestId && paymentId && secret) {
        const crypto = require('crypto');
        const parts = xSignature.split(',');
        let ts, hash;
        parts.forEach(part => {
            const [key, value] = part.split('=');
            if (key === 'ts') ts = value;
            if (key === 'v1') hash = value;
        });

        const manifest = `id:${paymentId};request-id:${xRequestId};ts:${ts};`;
        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(manifest).digest('hex');

        if (digest !== hash) {
            console.error('Invalid Mercado Pago Webhook Signature!');
            return res.status(403).send('Invalid signature');
        }
    } else {
        console.warn('Skipping MP webhook validation (missing headers/secret/id).');
    }

    console.log("MP Webhook received:", req.query, req.body);

    if (topic === 'payment' && paymentId) {
        try {
            // Obtener detalles completos del pago usando la SDK v2
            const { Payment } = require('mercadopago');
            const paymentClient = new Payment(client);

            const paymentInfo = await paymentClient.get({ id: paymentId });

            console.log(`Payment Status: ${paymentInfo.status}, Reference: ${paymentInfo.external_reference}`);

            if (paymentInfo.status === 'approved') {
                const orderId = paymentInfo.external_reference;

                if (orderId) {
                    // Update the order in Firestore
                    await admin.firestore().collection('orders').doc(orderId).update({
                        status: 'paid',
                        mpPaymentId: paymentId,
                        paidAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    console.log(`✅ Orden ${orderId} marcada como pagada en Firestore.`);

                    // TODO: Integración Order Entry API de Ingram
                    // Aquí llamaremos a Ingram
                }
            }

            res.status(200).send('OK');

        } catch (error) {
            console.error('Error fetching payment details from MP:', error);
            res.status(500).send('Error processing payment notification');
        }
    } else {
        // Obviar otros notificaciones (mercadoenvios, tests)
        res.status(200).send('Not a payment event, ignored.');
    }
});
