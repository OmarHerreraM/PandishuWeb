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
// ─── PAYMENTS: STRIPE INTEGRATION ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const getStripe = () => {
    if (!process.env.STRIPE_SECRET_KEY) {
        console.warn("Missing STRIPE_SECRET_KEY env variable");
        return null;
    }
    return require('stripe')(process.env.STRIPE_SECRET_KEY);
};

const YOUR_DOMAIN = 'https://pandishu-web-1d860.web.app'; // Production URL

/**
 * FUNCTION 4 — createCheckoutSession
 * POST body: { items: [...], customer: {...} }
 * Crea una sesión de Checkout de Stripe y devuelve la URL para redirigir al usuario.
 */
exports.createCheckoutSession = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const stripe = getStripe();
        if (!stripe) return res.status(500).json({ error: 'Stripe is not configured in environment variables' });

        try {
            const { items, customer } = req.body;

            if (!items || items.length === 0) {
                return res.status(400).json({ error: 'El carrito está vacío' });
            }

            // Mapear los items del carrito a la estructura de Stripe (line_items)
            const lineItems = items.map(item => {
                return {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: item.name,
                            description: `SKU: ${item.sku} | Vendor: ${item.vendor}`,
                            metadata: {
                                sku: item.sku,
                                vendor: item.vendor
                            }
                        },
                        // Stripe espera el monto en la unidad más pequeña (centavos para USD)
                        unit_amount: Math.round(item.price * 100),
                    },
                    quantity: item.quantity,
                };
            });

            // Crear la sesión en Stripe
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: lineItems,
                mode: 'payment',
                success_url: `${YOUR_DOMAIN}/order-confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${YOUR_DOMAIN}/checkout.html`,
                submit_type: 'pay',
                // Pasamos los datos del cliente y envío en la metadata para recuperarlos en el webhook
                metadata: {
                    customer_name: customer.name,
                    customer_email: customer.email,
                    customer_phone: customer.phone,
                    shipping_street: customer.address.street,
                    shipping_colonia: customer.address.colonia,
                    shipping_zip: customer.address.zip,
                    shipping_city: customer.address.city,
                    shipping_state: customer.address.state,
                    shipping_notes: customer.address.notes || '',
                    items_json: JSON.stringify(items.map(i => ({ sku: i.sku, qty: i.quantity, price: i.price, name: i.name, vendor: i.vendor })))
                },
                customer_email: customer.email,
            });

            return res.status(200).json({ url: session.url });

        } catch (err) {
            console.error('Error createCheckoutSession:', err);
            return res.status(500).json({ error: err.message });
        }
    });
});

/**
 * FUNCTION 5 — stripeWebhook
 * Webhook Seguro de Stripe (Solo se dispara cuando el pago ha sido exitoso: checkout.session.completed)
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(500).send('Stripe is not configured');

    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        // En Firebase Functions, req.rawBody contiene el raw Buffer necesario para verificar la firma
        event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
        console.error(`⚠️ Webhook signature verification failed:`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Manejar el evento
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        console.log(`🎉 Pago Exitoso! Sesión ID: ${session.id}`);

        const metadata = session.metadata;

        // Crear un documento en Firestore con la orden
        try {
            const orderRef = await admin.firestore().collection('orders').add({
                stripeSessionId: session.id,
                paymentIntentId: session.payment_intent,
                amountTotal: session.amount_total / 100, // De centavos a dólares
                status: 'paid', // Status interno 'paid', luego cambiará a 'sent_to_ingram' o 'shipped'
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                customerInfo: {
                    name: metadata.customer_name,
                    email: metadata.customer_email,
                    phone: metadata.customer_phone,
                },
                shippingAddress: {
                    street: metadata.shipping_street,
                    colonia: metadata.shipping_colonia,
                    zip: metadata.shipping_zip,
                    city: metadata.shipping_city,
                    state: metadata.shipping_state,
                    notes: metadata.shipping_notes,
                },
                items: JSON.parse(metadata.items_json),
                ingramStatus: 'pending' // Estado de integración con Ingram
            });

            console.log(`✅ Orden guardada en Firestore. Documento: ${orderRef.id}`);

            // TODO: Integración Order Entry API de Ingram
            // Aquí en el futuro leeremos la orden de Firestore y generaremos la petición
            // a la API de Ingram para ejecutar el Dropshipping

        } catch (dbError) {
            console.error("Error guardando la orden en Firestore:", dbError);
            return res.status(500).json({ error: 'Database write failed', details: dbError.message });
        }
    }

    res.json({ received: true });
});
