'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');
const nodemailer = require('nodemailer');

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
// CONFIGURACIÓN DE CORREO (Nodemailer)
// ─────────────────────────────────────────────────────────────────────────────
let mailTransporter = null;
const getMailTransporter = () => {
    if (mailTransporter) return mailTransporter;
    if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
        mailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_EMAIL,
                pass: process.env.SMTP_PASSWORD
            }
        });
    }
    return mailTransporter;
};

async function enviarCorreoConfirmacion(toEmail, customerName, orderId, cartItems, totalAmount) {
    const transporter = getMailTransporter();
    if (!transporter) {
        console.warn('⚠️ No se envió correo: SMTP_EMAIL o SMTP_PASSWORD no están configurados.');
        return;
    }

    // Generar la lista de productos en HTML
    let itemsHtml = '';
    cartItems.forEach(item => {
        itemsHtml += `
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #e2e8f0;">${item.name} (x${item.quantity})</td>
                <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); color: #e2e8f0; text-align: right;">$${Number(item.price * item.quantity).toFixed(2)} MXN</td>
            </tr>
        `;
    });

    const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px; line-height: 1.6;">
        <div style="max-width: 600px; margin: 0 auto; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 16px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0; font-size: 32px;">PANDISHÚ</h1>
                <p style="color: #94a3b8; font-size: 14px; letter-spacing: 2px;">TECHNOLOGY SOLUTIONS</p>
            </div>
            
            <h2 style="color: #e2e8f0; border-bottom: 2px solid #334155; padding-bottom: 10px;">¡Gracias por tu compra, ${customerName}!</h2>
            <p style="color: #cbd5e1;">Tu orden <strong>#${orderId}</strong> ha sido confirmada y el pago fue procesado exitosamente. Estamos preparando tus productos para el envío.</p>
            
            <div style="margin: 30px 0; background: rgba(15, 23, 42, 0.5); border-radius: 8px; padding: 15px;">
                <h3 style="color: #a855f7; margin-top: 0;">Resumen del Pedido</h3>
                <table style="width: 100%; border-collapse: collapse;">
                    ${itemsHtml}
                    <tr>
                        <td style="padding: 10px; font-weight: bold; color: #fff; text-align: right;">TOTAL:</td>
                        <td style="padding: 10px; font-weight: bold; color: #a855f7; text-align: right; font-size: 18px;">$${Number(totalAmount).toFixed(2)} MXN</td>
                    </tr>
                </table>
            </div>
            
            <p style="color: #94a3b8; font-size: 13px; text-align: center; margin-top: 40px; border-top: 1px solid #334155; padding-top: 20px;">
                Cualquier duda, responde a este correo o contáctanos por WhatsApp.<br>
                © ${new Date().getFullYear()} Pandishú. Todos los derechos reservados.
            </p>
        </div>
    </div>
    `;

    try {
        await transporter.sendMail({
            from: '"Pandishú Tech" <' + process.env.SMTP_EMAIL + '>',
            to: toEmail,
            subject: 'Confirmación de Pedido #' + orderId,
            html: emailHtml
        });
        console.log(`✉️ Correo de confirmación enviado a ${toEmail} para la orden ${orderId}`);
    } catch (error) {
        console.error('Error enviando correo con Nodemailer:', error);
    }
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
            // Usa los Mocks explícitamente si está configurado así en las variables
            if (process.env.USE_MOCK_DATA === 'true') {
                console.log('🔹 Sirviendo catálogo MOCK por configuración USE_MOCK_DATA=true');
                return res.status(200).json(getMockSearchData(req.query.keyword));
            }

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

            // Mapeo defensivo para asegurar que el Front-end siempre reciba la estructura esperada:
            const safeCatalog = (data.catalog || []).map(p => ({
                ingramPartNumber: p.ingramPartNumber || '',
                vendorName: p.vendorName || 'Desconocido',
                vendorPartNumber: p.vendorPartNumber || '',
                description: p.description || 'Producto sin descripción',
                upc: p.upc || '',
                productCategory: p.productCategory || ''
            }));

            // Guardar en Firestore Cache (Búsquedas completas)
            // Esto ahorra cuota de la API para búsquedas repetidas
            try {
                if (req.query.keyword) {
                    await admin.firestore().collection('products_cache').doc(`search_${req.query.keyword}`).set({
                        catalog: safeCatalog,
                        timestamp: FieldValue.serverTimestamp()
                    });
                }
            } catch (cacheErr) {
                console.warn("⚠️ No se pudo guardar en cache:", cacheErr.message);
            }

            return res.status(200).json({
                recordsFound: data.recordsFound || safeCatalog.length,
                catalog: safeCatalog
            });
        } catch (err) {
            console.error('searchProducts falló (Error de API):', err.message || err);
            console.warn('⚠️ ENTRANDO EN MOCK DATA FALLBACK POR ERROR DE API');
            return res.status(200).json(getMockSearchData(req.query.keyword));
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────
function getMockSearchData(queryKeyword) {
    const mockCatalog = [
        { ingramPartNumber: "MOCK-UBI-01", vendorName: "UBIQUITI", vendorPartNumber: "UAP-AC-PRO", description: "Ubiquiti UniFi AC Pro AP - Punto de acceso inalámbrico - 802.11a/b/g/n/ac - Banda doble" },
        { ingramPartNumber: "MOCK-CIS-01", vendorName: "CISCO", vendorPartNumber: "CBS350-24T-4G", description: "Cisco Business 350 Series 24-Port Gigabit Managed Switch" },
        { ingramPartNumber: "MOCK-DEL-01", vendorName: "DELL", vendorPartNumber: "XPS-13-9315", description: "Dell XPS 13 9315 - Intel Core i7 1250U - 16GB RAM - 512GB SSD - 13.4\" FHD+" },
        { ingramPartNumber: "MOCK-SAM-01", vendorName: "SAMSUNG", vendorPartNumber: "MZ-V8V1T0B/AM", description: "Samsung 980 SSD 1TB PCle 3.0x4, NVMe M.2 2280" },
        { ingramPartNumber: "MOCK-APP-01", vendorName: "APPLE", vendorPartNumber: "MGN63LA/A", description: "MacBook Air 13.3\" - Apple M1 - 8GB RAM - 256GB SSD - Gris Espacial" },
        { ingramPartNumber: "MOCK-LOG-01", vendorName: "LOGITECH", vendorPartNumber: "910-005620", description: "Logitech MX Master 3S Mouse Inalámbrico, Desplazamiento Ultrarrápido" },
        { ingramPartNumber: "MOCK-APC-01", vendorName: "APC", vendorPartNumber: "BR1500G", description: "APC Back-UPS Pro 1500VA, 865W, 10 Outlets" },
        { ingramPartNumber: "MOCK-LEN-01", vendorName: "LENOVO", vendorPartNumber: "21A400A7US", description: "Lenovo ThinkPad E15 Gen 4 - AMD Ryzen 5 - 16GB RAM - 512GB SSD" },
        { ingramPartNumber: "MOCK-SYN-01", vendorName: "SYNOLOGY", vendorPartNumber: "DS923+", description: "Synology DiskStation DS923+ 4-Bay NAS Enclosure" },
        { ingramPartNumber: "MOCK-HP-01", vendorName: "HP", vendorPartNumber: "400-G9-SFF", description: "HP ProDesk 400 G9 SFF - Intel Core i5 12500 - 16GB RAM - 512GB SSD" }
    ];

    let filteredMocks = mockCatalog;
    const keyword = queryKeyword ? queryKeyword.toLowerCase() : '';
    if (keyword && keyword !== 'all') {
        filteredMocks = mockCatalog.filter(p =>
            p.description.toLowerCase().includes(keyword) ||
            p.vendorName.toLowerCase().includes(keyword) ||
            p.ingramPartNumber.toLowerCase().includes(keyword)
        );
    }
    return { recordsFound: filteredMocks.length, catalog: filteredMocks };
}

function getMockPricingData(skus) {
    const mockPrices = {
        "MOCK-UBI-01": 149.99, "MOCK-CIS-01": 299.50, "MOCK-DEL-01": 1250.00,
        "MOCK-SAM-01": 85.99, "MOCK-APP-01": 999.00, "MOCK-LOG-01": 99.99,
        "MOCK-APC-01": 215.00, "MOCK-LEN-01": 850.00, "MOCK-SYN-01": 599.99,
        "MOCK-HP-01": 720.00
    };
    return skus.map(sku => {
        const basePrice = mockPrices[sku] || 150.00;
        const stock = sku.includes('MOCK') ? (sku.charCodeAt(sku.length - 2) * 2) : 5;
        return {
            ingramPartNumber: sku,
            pricing: { customerPrice: basePrice, currencyCode: "USD" },
            availability: {
                availableQuantity: stock, totalAvailability: stock,
                availabilityByWarehouse: [{ warehouseId: "CA", quantityAvailable: stock }]
            }
        };
    });
}


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
            if (process.env.USE_MOCK_DATA === 'true') {
                console.log('🔹 Sirviendo precios MOCK por configuración USE_MOCK_DATA=true');
                return res.status(200).json(getMockPricingData(skus));
            }

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

            // Extraemos solo lo necesario y lo estructuramos igual que el mock para no romper el front
            const safePricing = (data || []).map(p => ({
                ingramPartNumber: p.ingramPartNumber || '',
                pricing: {
                    customerPrice: p.pricing ? p.pricing.customerPrice : 0,
                    currencyCode: p.pricing ? p.pricing.currencyCode : 'USD'
                },
                availability: {
                    availableQuantity: p.availability ? p.availability.availableQuantity : 0,
                    totalAvailability: p.availability ? p.availability.totalAvailability : 0,
                    availabilityByWarehouse: p.availability ? p.availability.availabilityByWarehouse : []
                }
            }));

            // Actualizar Cache local de inventario
            try {
                const batch = admin.firestore().batch();
                safePricing.forEach(item => {
                    const docRef = admin.firestore().collection('products_cache').doc(item.ingramPartNumber);
                    batch.set(docRef, { ...item, lastPaUpdate: FieldValue.serverTimestamp() }, { merge: true });
                });
                await batch.commit();
            } catch (e) { console.warn("⚠️ Error guardando caché de P&A", e.message); }

            return res.status(200).json(safePricing);
        } catch (err) {
            console.error('getPriceAndAvailability error:', err.message || err);
            console.warn('⚠️ USING MOCK DATA FOR PRICE/AVAIL DUE TO API ERROR');
            return res.status(200).json(getMockPricingData(skus));
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
        const crypto = require('crypto');
        const signature = req.headers['x-hub-signature'] || req.headers['authorization'] || '';
        const eventId = req.body.eventId;

        let isValid = false;
        if (IM_SECRET_KEY && eventId) {
            const hmac = crypto.createHmac('sha512', IM_SECRET_KEY);
            hmac.update(eventId, 'utf-8');
            const expectedSignature = hmac.digest('base64');

            if (signature === expectedSignature || signature.includes(expectedSignature)) {
                isValid = true;
            } else {
                console.warn('[Ingram Webhook] Signature mismatch. Expected:', expectedSignature, 'Got:', signature);
            }
        } else {
            console.warn('[Ingram Webhook] Missing IM_SECRET_KEY or eventId in payload.');
        }

        // Permitimos continuar si es local/sandbox por motivos de dev, pero marcamos warning
        if (!isValid) {
            console.warn('⚠️ Webhook Payload no validado por firma SHA512.');
            // return res.status(401).send('Unauthorized webhook'); // Descomentar en Prod Estricto
        }

        const payload = req.body;
        console.log(`[Ingram Webhook] Recibido eventId: ${eventId}`);

        // Guardar raw payload en Firestore para auditoría
        try {
            await admin.firestore().collection('ingram_events').add({
                receivedAt: FieldValue.serverTimestamp(),
                eventId: eventId || 'unknown',
                topic: payload.topic || 'unknown',
                rawPayload: payload,
                isValidSignature: isValid
            });
        } catch (dbErr) {
            console.warn('⚠️ No se pudo guardar auditorio en Firestore (probablemente no inicializado localmente).', dbErr.message);
        }

        // ─── PROCESAMIENTO DE RECURSOS SEGÚN EVENTO ───
        if (payload.resource && Array.isArray(payload.resource)) {
            for (const resource of payload.resource) {
                const eventType = resource.eventType ? resource.eventType.toLowerCase() : '';

                // 1) STOCK_UPDATE: Actualizamos el caché de disponibilidad
                if (eventType === 'im::stock_update') {
                    const sku = resource.ingramPartNumber;
                    const stockStr = resource.totalAvailability;
                    if (sku && stockStr != null) {
                        try {
                            const stockNum = parseInt(stockStr, 10);
                            await admin.firestore().collection('products_cache').doc(sku).set({
                                ingramPartNumber: sku,
                                availableQuantity: stockNum,
                                lastWebhookUpdate: FieldValue.serverTimestamp()
                            }, { merge: true });
                            console.log(`✅ Cache actualizado: SKU ${sku} tiene ${stockNum} en stock.`);
                        } catch (e) { console.error('Error guardando cache:', e.message); }
                    }
                }

                // 2) ACTUALIZACIONES DE ÓRDENES: shipped, invoiced, voided, hold, etc.
                if (eventType.startsWith('im::order_')) {
                    const ingramOrderNumber = resource.orderNumber;
                    const customerOrderNumber = resource.customerOrderNumber; // Este es nuestro orderRefUid de Firestore

                    if (customerOrderNumber) {
                        const updateData = {
                            ingramStatus: eventType.replace('im::order_', ''),
                            ingramOrderNumber: ingramOrderNumber,
                            lastIngramUpdate: FieldValue.serverTimestamp()
                        };

                        // Extraer tracking de shipmentDetails (si existe para order_shipped)
                        if (eventType === 'im::order_shipped' && resource.lines) {
                            let trackingNums = [];
                            resource.lines.forEach(line => {
                                if (line.shipmentDetails) {
                                    line.shipmentDetails.forEach(ship => {
                                        if (ship.packageDetails) {
                                            ship.packageDetails.forEach(pkg => {
                                                if (pkg.trackingNumber) trackingNums.push(pkg.trackingNumber);
                                            });
                                        }
                                    });
                                }
                            });
                            if (trackingNums.length > 0) {
                                updateData.trackingNumbers = trackingNums;
                            }
                        }

                        try {
                            // Actualizar la orden de nuestro lado
                            await admin.firestore().collection('orders').doc(customerOrderNumber).update(updateData);
                            console.log(`✅ Orden ${customerOrderNumber} actualizada con estado ${updateData.ingramStatus}`);
                        } catch (e) {
                            console.error(`⚠️ No se pudo actualizar orden ${customerOrderNumber} en Firestore:`, e.message);
                        }
                    }
                }
            }
        }

        // Siempre devolver 200 rápido a Ingram para no causar retries
        return res.status(200).json({ status: 'received', eventId });
    } catch (err) {
        console.error('[Ingram Webhook] Error Crítico:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
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
                    description: `Vendor: ${item.vendor || 'Pandishú'}`,
                    quantity: item.quantity,
                    currency_id: 'MXN',
                    unit_price: Number(item.price)
                };
            });

            // Agregamos el costo de envío fijo mandatorio
            const shippingCost = 149.00;
            preferenceItems.push({
                id: 'SHIPPING-01',
                title: 'Envío Estándar',
                description: 'Costo fijo de envío a domicilio',
                quantity: 1,
                currency_id: 'MXN',
                unit_price: shippingCost
            });

            // Metadata must be serialized as external_reference or saved before/after
            // We use external_reference as a unique ID to link back to Firestore
            // Let's create an order document IN ADVANCE with status "pending"
            let orderRefId = `mock-order-${Date.now()}`;
            try {
                const orderRef = await admin.firestore().collection('orders').add({
                    status: 'pending_payment',
                    createdAt: FieldValue.serverTimestamp(),
                    customerInfo: customer,
                    items: items,
                    shippingCost: shippingCost,
                    ingramStatus: 'pending',
                    amountTotal: items.reduce((sum, item) => sum + (item.price * item.quantity), 0) + shippingCost
                });
                orderRefId = orderRef.id;
            } catch (dbErr) {
                console.warn('⚠️ Firestore save failed (likely not initialized). Using mock order ID.', dbErr.message);
            }

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
                    external_reference: orderRefId, // Vínculo con nuestra BD
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
                        paidAt: FieldValue.serverTimestamp()
                    });

                    console.log(`✅ Orden ${orderId} marcada como pagada en Firestore.`);

                    // ─── Enviar Correo Electrónico al Cliente ───
                    try {
                        const orderDoc = await admin.firestore().collection('orders').doc(orderId).get();
                        if (orderDoc.exists) {
                            const data = orderDoc.data();
                            await enviarCorreoConfirmacion(
                                data.customerInfo.email,
                                data.customerInfo.name,
                                orderId,
                                data.items,
                                data.amountTotal
                            );
                        }
                    } catch (mailErr) {
                        console.error('⚠️ No se pudo enviar el correo transaccional:', mailErr.message);
                    }

                    // TODO: Integración Order Entry API de Ingram
                    // Aquí llamaremos a la creación de orden real en Ingram Micro
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
