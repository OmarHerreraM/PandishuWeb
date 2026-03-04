'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');
const nodemailer = require('nodemailer');
const https = require('https');

admin.initializeApp();

// ─── SMART SEARCH UTILITIES ───────────────────────────────────────────────────
/**
 * Brand aliases: maps all known misspellings/variations to a canonical form.
 * When user types any of the keys, the search expands to the canonical value.
 */
const BRAND_ALIASES = {
    // TP-Link
    'tplink': 'tp-link', 'tp link': 'tp-link', 'tepelinc': 'tp-link', 'tplinck': 'tp-link',
    'tp_link': 'tp-link', 'tplink1': 'tp-link', 'teplink': 'tp-link', 'tep-link': 'tp-link',
    // Ubiquiti
    'ubiquiti': 'ubiquiti', 'ubnt': 'ubiquiti', 'ubiquit': 'ubiquiti', 'unifi': 'ubiquiti',
    // Cisco
    'sisco': 'cisco', 'sisco': 'cisco',
    // HP
    'hewlett': 'hp', 'hewlett packard': 'hp',
    // Logitech
    'logi': 'logitech', 'logitec': 'logitech', 'lojitec': 'logitech',
    // Samsung
    'samsunh': 'samsung', 'samsun': 'samsung',
    // Kingston
    'kingstone': 'kingston', 'kignston': 'kingston',
    // Epson
    'epzon': 'epson', 'apson': 'epson',
    // Hikvision
    'hikvizion': 'hikvision', 'hik': 'hikvision', 'hkvision': 'hikvision',
    // D-Link
    'dlink': 'd-link', 'd link': 'd-link',
    // Western Digital
    'wd': 'western digital', 'western digital': 'western digital', 'wdc': 'western digital',
    // ASUS
    'azus': 'asus', 'assus': 'asus',
    // Lenovo
    'lenovvo': 'lenovo', 'lenovio': 'lenovo',
};

/**
 * Normalize a string for fuzzy matching:
 * - Lowercase
 * - Remove accents/diacritics (á→a, é→e, ñ→n, etc.)
 * - Collapse whitespace
 */
function normalizeSearch(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD')               // decompose accented chars
        .replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .replace(/[^a-z0-9\s\-]/g, ' ') // keep only alphanum + hyphen
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolve search terms: expand brand aliases and split into tokens.
 * Returns an array of token-arrays to try. Any token-array that fully
 * matches the product is a hit.
 */
function resolveSearchTerms(rawKeyword) {
    const norm = normalizeSearch(rawKeyword);
    const termSets = [];

    // Helper to add a token-set (split into words)
    const addTokenSet = (str) => {
        const tokens = str.split(' ').filter(w => w.length >= 1);
        if (tokens.length > 0) termSets.push(tokens);
    };

    // Original normalized query as tokens
    addTokenSet(norm);

    // Replace brand aliases in the query
    let aliasExpanded = norm;
    const words = norm.split(' ');
    words.forEach(w => {
        if (BRAND_ALIASES[w]) aliasExpanded = aliasExpanded.replace(w, BRAND_ALIASES[w]);
    });
    if (BRAND_ALIASES[norm]) aliasExpanded = BRAND_ALIASES[norm];
    if (aliasExpanded !== norm) addTokenSet(aliasExpanded);

    // Add hyphen-stripped and hyphen-joined variants
    addTokenSet(norm.replace(/-/g, ' '));
    addTokenSet(norm.replace(/\s/g, '-'));

    return termSets; // array of token-arrays
}

/**
 * Check if a product matches a set of search terms.
 * Uses token-based matching: ALL tokens in a term-set must appear
 * in the product text. Uses prefix matching (min 3 chars), so
 * 'lapto' finds 'laptop', 'serv' finds 'servidor'.
 */
function productMatchesSearch(p, termSets) {
    const haystack = normalizeSearch([
        p.description || '',
        p.vendorName || '',
        p.ingramPartNumber || '',
        p.sku || '',
        p.brand || ''
    ].join(' '));

    // Tokenize haystack into individual words for prefix matching
    const haystackWords = haystack.split(' ').filter(w => w.length > 0);

    // Check if a single token matches the haystack (substring or prefix on any word)
    const tokenMatches = (token) => {
        if (haystack.includes(token)) return true; // direct substring match
        if (token.length >= 3) {
            // Prefix match: does any word in haystack start with this token?
            return haystackWords.some(hw => hw.startsWith(token) || token.startsWith(hw));
        }
        return false;
    };

    // A term-set matches if ALL its tokens match
    const termSetMatches = (tokens) => {
        if (tokens.length === 0) return false;
        const matched = tokens.filter(t => tokenMatches(t));
        // Strict: all tokens must match, but allow 1 miss if query is 3+ tokens (typo tolerance)
        if (tokens.length >= 3) {
            return matched.length >= tokens.length - 1; // allow 1 miss
        }
        return matched.length === tokens.length;
    };

    return termSets.some(termSetMatches);
}

// ─── AMAZON BEST SELLERS: Keyword list cached from Firestore ─────────────────
let amazonTopKeywords = new Set();
let amazonKeywordsLoaded = false;

async function loadAmazonTopKeywords() {
    try {
        const db = admin.firestore();
        const snap = await db.collection('top_sellers_index').get();
        amazonTopKeywords = new Set();
        snap.docs.forEach(d => {
            const data = d.data();
            if (Array.isArray(data.keywords)) {
                data.keywords.forEach(k => amazonTopKeywords.add(k.toLowerCase()));
            }
        });
        amazonKeywordsLoaded = true;
        console.log(`[AmazonIndex] Loaded ${amazonTopKeywords.size} top seller keywords from Firestore.`);
    } catch (e) {
        console.warn('[AmazonIndex] Could not load top seller keywords:', e.message);
    }
}

function matchesAmazonTopSeller(product) {
    if (!amazonKeywordsLoaded || amazonTopKeywords.size === 0) return false;
    const searchText = [
        product.description || '',
        product.vendorName || '',
        product.ingramPartNumber || '',
        product.sku || ''
    ].join(' ').toLowerCase();
    for (const kw of amazonTopKeywords) {
        if (searchText.includes(kw)) return true;
    }
    return false;
}

/**
 * Calculates a relevance score for a product.
 * Score favors: high stock, high price (main product not accessory), and Amazon top-seller match.
 * Score is used for default "Relevancia" sort in tienda and topVentas in index.
 */
function calcProductScore(p) {
    const stock = Math.min(p.stock || 0, 200); // Cap at 200 to not skew too much
    const price = parseFloat(p.price) || 0;

    // Category weight: boost products priced above MXN $500 (accessories are usually below)
    const priceBoost = price > 10000 ? 4.0
        : price > 3000 ? 2.5
            : price > 1000 ? 1.5
                : price > 500 ? 1.0
                    : 0.3; // cheap accessories get suppressed

    // Stock boost: products with good availability
    const stockBoost = stock > 50 ? 2.0
        : stock > 10 ? 1.5
            : stock > 3 ? 1.0
                : stock > 0 ? 0.5
                    : 0; // zero stock products get zeroed out on score

    // Amazon match adds a major boost
    const amazonBoost = matchesAmazonTopSeller(p) ? 3.0 : 1.0;

    return priceBoost * stockBoost * amazonBoost * Math.log10(price + 1);
}

// ─── CT CONNECT CONFIG ────────────────────────────────────────────────────────
const CT_API_BASE = process.env.CT_API_BASE || 'https://api.ctonline.mx';
const CT_CLIENT_NUM = process.env.CT_CLIENT_NUMBER;
const CT_EMAIL = process.env.CT_EMAIL;
const CT_RFC = process.env.CT_RFC;

// ─── CONVERSIÓN DE MONEDA ───────────────────────────────────────────────────
const MXN_RATE = parseFloat(process.env.MXN_EXCHANGE_RATE) || 17.50;
function usdToMxn(usdPrice) {
    if (!usdPrice || isNaN(usdPrice)) return { price: 0, currency: 'MXN' };
    return { price: Math.round(usdPrice * MXN_RATE * 100) / 100, currency: 'MXN' };
}

// ─── TOKEN CT CONNECT AUTOMATIZATION ──────────────────────────────────────────
const { generateCTToken } = require('./services/ctConnect');

// Scheduled function to run every day to keep the CT Token fresh for dropshipping
exports.scheduledCTTokenRefresh = functions.pubsub.schedule('every 23 hours').onRun(async (context) => {
    console.log('Running scheduled CT Token refresh...');
    const newToken = await generateCTToken();
    if (newToken) {
        // Save the token to Firestore so all instances can use it
        await admin.firestore().collection('system_config').doc('ct_auth').set({
            token: newToken,
            updatedAt: FieldValue.serverTimestamp()
        });
        console.log('CT Token successfully refreshed and stored in Firestore.');
    } else {
        console.error('Failed to generate new CT Token during scheduled refresh.');
    }
    return null;
});

// Helper function to dynamically retrieve the fresh CT token inside APIs
async function getCTToken() {
    const doc = await admin.firestore().collection('system_config').doc('ct_auth').get();
    if (doc.exists && doc.data().token && doc.data().updatedAt) {
        const updatedAt = doc.data().updatedAt.toDate().getTime();
        const now = Date.now();
        const ageInHours = (now - updatedAt) / (1000 * 60 * 60);

        // Security Standard: Los tokens de CT caducan cada 24 horas. Refrescar si tiene > 22 horas.
        if (ageInHours < 22) {
            return doc.data().token;
        }
        console.log('CT Token found but expired. Generating a new one...');
    }

    // Fallback: Generate it right now if it doesn't exist or is expired
    const newToken = await generateCTToken();
    if (newToken) {
        await admin.firestore().collection('system_config').doc('ct_auth').set({
            token: newToken,
            updatedAt: FieldValue.serverTimestamp()
        });
        return newToken;
    }
    throw new Error('No se pudo generar un token de CT.');
}

// ─── CONFIGURACIÓN DE CORREO ──────────────────────────────────────────────────
let mailTransporter = null;
const getMailTransporter = () => {
    if (mailTransporter) return mailTransporter;
    if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
        mailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD }
        });
    }
    return mailTransporter;
};

// ─── SERVICIOS DE ENVÍO (CT Dropshipping gestionado en checkout) ─────────────────

async function enviarCorreoConfirmacion(toEmail, customerName, orderId, cartItems, totalAmount) {
    const transporter = getMailTransporter();
    if (!transporter) return;

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
    <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 30px;">
            <h1 style="color: #a855f7; text-align: center;">PANDISHÚ</h1>
            <h2>¡Gracias por tu compra, ${customerName}!</h2>
            <p>Tu orden #<strong>${orderId}</strong> ha sido recibida.</p>
            <table style="width: 100%; border-collapse: collapse;">${itemsHtml}</table>
            <h3 style="text-align: right;">Total: $${Number(totalAmount).toFixed(2)} MXN</h3>
        </div>
    </div>`;

    try {
        await transporter.sendMail({
            from: '"Pandishú Tech" <' + process.env.SMTP_EMAIL + '>',
            to: [toEmail, process.env.SMTP_EMAIL],
            subject: 'Confirmación de Pedido #' + orderId,
            html: emailHtml
        });
    } catch (e) { console.error('Email error:', e); }
}

// ─── TRACKING EMAIL ────────────────────────────────────────────────────────────
async function enviarCorreoEnvio(toEmail, customerName, orderId, tracking) {
    const transporter = getMailTransporter();
    if (!transporter) return;

    const trackingUrl = `https://track.aftership.com/${tracking.number}`;

    const emailHtml = `
    <div style="font-family: sans-serif; background-color: #0f172a; color: #f8fafc; padding: 40px 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 30px;">
            <h1 style="color: #a855f7; text-align: center;">PANDISHÚ</h1>
            <h2 style="color: #4ade80;">🚚 ¡Tu pedido está en camino!</h2>
            <p>Hola <strong>${customerName}</strong>, tu orden <strong>#${orderId.slice(-8)}</strong> fue despachada.</p>
            <div style="background: #0f172a; border-radius: 12px; padding: 20px; margin: 20px 0;">
                <p style="margin: 6px 0; font-size: 13px; color: #94a3b8;">Paquetería</p>
                <p style="margin: 6px 0; font-size: 18px; font-weight: 900; color: #a5b4fc; text-transform: uppercase;">${tracking.carrier || 'CT DropShipping'}</p>
                <p style="margin: 12px 0 4px; font-size: 13px; color: #94a3b8;">Número de Guía</p>
                <p style="margin: 6px 0; font-size: 22px; font-weight: 900; font-family: monospace; color: #ffffff; letter-spacing: 2px;">${tracking.number}</p>
            </div>
            <div style="text-align: center; margin: 24px 0;">
                <a href="${trackingUrl}" style="background: #6366f1; color: white; font-weight: 900; font-size: 14px; text-decoration: none; padding: 14px 28px; border-radius: 12px; display: inline-block; text-transform: uppercase; letter-spacing: 1px;">
                    📍 Rastrear mi Pedido
                </a>
            </div>
            <p style="text-align: center; font-size: 11px; color: #475569; margin-top: 24px;">
                ¿Dudas? Escríbenos a <a href="mailto:pandipandishu@gmail.com" style="color: #818cf8;">pandipandishu@gmail.com</a>
            </p>
        </div>
    </div>`;

    try {
        await transporter.sendMail({
            from: '"Pandishú Tech" <' + process.env.SMTP_EMAIL + '>',
            to: [toEmail, process.env.SMTP_EMAIL],
            subject: `🚚 Tu pedido #${orderId.slice(-8)} fue enviado — Guía: ${tracking.number}`,
            html: emailHtml
        });
        console.log(`[Email Envio] Tracking email sent to ${toEmail}`);
    } catch (e) { console.error('[Email Envio] Error:', e); }
}

// ─── FULFILLMENT LOOP (Antigravity OS v2.0) ──────────────────────────────────
/**
 * Orquesta el ciclo completo post-pago:
 * 1. CT Volumetría → dimensiones del paquete
 * 2. SkydropX Quote → cotización de envío
 * 3. SkydropX Shipment → guía + tracking number
 * 4. CT Upload Guía → enlaza la guía al pedido CT
 * 5. Firestore Update → status: 'shipped' + datos logísticos
 * 6. Email al cliente → confirmación de envío con tracking
 */
async function runFulfillmentLoop(orderData, ctOrdersLog, orderRef) {
    const { getCTVolumetry, uploadLabelToCT } = require('./services/ctConnect');
    const { getSkydropXQuote, createSkydropXShipment } = require('./services/skydropX');

    const customer = orderData.customerInfo || {};
    const address = customer.address || {};
    const items = orderData.items || [];
    const destZip = (address.zip || orderData.shippingInfo?.zipCode || '06600').replace(/\D/g, '');

    let fulfillmentLog = { steps: [], errors: [] };
    let trackingResult = null;
    let skydropxCost = 0;

    try {
        const ctToken = await getCTToken();

        // ── STEP 1: CT Volumetría ──────────────────────────────────────────────
        let totalWeight = 0, maxLength = 0, maxWidth = 0, maxHeight = 0;
        for (const item of items) {
            if (!item.sku) continue;
            try {
                const vol = await getCTVolumetry(item.sku, ctToken);
                if (vol) {
                    const qty = item.quantity || 1;
                    totalWeight += (parseFloat(vol.peso) || 0.5) * qty;
                    maxLength = Math.max(maxLength, parseFloat(vol.largo) || 20);
                    maxWidth = Math.max(maxWidth, parseFloat(vol.ancho) || 20);
                    maxHeight += (parseFloat(vol.alto) || 10) * qty;
                }
            } catch (e) { fulfillmentLog.errors.push(`Volumetry ${item.sku}: ${e.message}`); }
        }
        // Safety minimums
        const parcel = {
            weight_kg: Math.max(totalWeight, 0.3),
            length_cm: Math.max(maxLength, 15),
            width_cm: Math.max(maxWidth, 15),
            height_cm: Math.max(maxHeight, 10)
        };
        fulfillmentLog.steps.push({ step: 'volumetry', parcel });
        console.log('[Fulfillment] Parcel dimensions:', parcel);

        // ── STEP 2: SkydropX Quote ────────────────────────────────────────────
        // Try to get origin ZIP from CT warehouse of the first CT order
        const ctAlmacen = ctOrdersLog?.[0]?.almacen || '01A';
        const { warehouses } = require('./services/warehouseManager');
        const whData = warehouses.find(w => w.id === ctAlmacen);
        const originZip = (whData?.zipCode || '06600').toString();

        const rates = await getSkydropXQuote({ fromZip: originZip, toZip: destZip, parcel });
        if (!rates || rates.length === 0) {
            fulfillmentLog.errors.push('No SkydropX rates available');
        } else {
            const selectedRate = rates[0]; // Cheapest
            skydropxCost = parseFloat(selectedRate.total_price || selectedRate.price || 0);
            fulfillmentLog.steps.push({ step: 'quote', rate: selectedRate.carrier, cost: skydropxCost });
            console.log(`[Fulfillment] SkydropX rate: ${selectedRate.carrier} $${skydropxCost}`);

            // ── STEP 3: SkydropX Shipment ────────────────────────────────────
            const sender = {
                name: 'Pandishú Tech', company: 'Pandishú',
                email: process.env.SMTP_EMAIL, phone: '5500000000',
                street: whData?.address || 'Almacén CT',
                number: 'S/N', district: 'Centro',
                city: whData?.city || 'Ciudad de Mexico',
                state: 'CMX', zipCode: originZip
            };
            const recipient = {
                name: customer.name, email: customer.email,
                phone: customer.phone,
                street: address.street, ext_number: address.ext_number,
                colonia: address.colonia, city: address.city,
                state: address.state, zipCode: destZip
            };

            const shipment = await createSkydropXShipment({
                quotationId: selectedRate.quotation_id || selectedRate.id,
                rateId: selectedRate.id,
                sender, recipient, parcel,
                reference: orderRef.id
            });

            if (shipment?.tracking_number) {
                trackingResult = {
                    number: shipment.tracking_number,
                    carrier: shipment.carrier,
                    label_url: shipment.label_url,
                    shipment_id: shipment.shipment_id
                };
                fulfillmentLog.steps.push({ step: 'shipment', tracking: trackingResult });
                console.log(`[Fulfillment] Tracking: ${shipment.tracking_number}`);

                // ── STEP 4: Upload label to CT (for each CT order) ───────────
                for (const ctOrder of (ctOrdersLog || [])) {
                    if (ctOrder.pedidoWeb) {
                        await uploadLabelToCT(
                            ctOrder.pedidoWeb,
                            shipment.tracking_number,
                            shipment.carrier,
                            '', // No base64 needed — CT just needs the tracking number
                            ctToken
                        );
                        fulfillmentLog.steps.push({ step: 'ct_guia', folio: ctOrder.pedidoWeb });
                    }
                }
            } else {
                fulfillmentLog.errors.push('SkydropX shipment creation failed or no tracking number returned');
            }
        }

    } catch (err) {
        fulfillmentLog.errors.push(`FulfillmentLoop fatal: ${err.message}`);
        console.error('[Fulfillment] Fatal error:', err);
    }

    // ── STEP 5: Firestore Update ─────────────────────────────────────────────
    const firestoreUpdate = {
        status: trackingResult ? 'shipped' : 'paid_pending_fulfillment',
        shippedAt: trackingResult ? FieldValue.serverTimestamp() : null,
        tracking: trackingResult || null,
        skydropxCost,
        fulfillmentLog
    };
    // Remove null fields
    Object.keys(firestoreUpdate).forEach(k => firestoreUpdate[k] === null && delete firestoreUpdate[k]);
    await orderRef.update(firestoreUpdate);
    console.log(`[Fulfillment] Firestore updated → status: ${firestoreUpdate.status}`);

    // ── STEP 6: Tracking Email ──────────────────────────────────────────────
    if (trackingResult && orderData.customerInfo?.email) {
        await enviarCorreoEnvio(
            orderData.customerInfo.email,
            orderData.customerInfo.name,
            orderRef.id,
            trackingResult
        );
    }

    return { trackingResult, skydropxCost, fulfillmentLog };
}

const { MercadoPagoConfig, Preference: MPPreference, Payment: MPPayment } = require('mercadopago');

const getMercadoPagoClient = () => {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) return null;
    return new MercadoPagoConfig({ accessToken: accessToken });
};

const YOUR_DOMAIN = 'https://www.pandishu.com';

// ─── FUNCTIONS ────────────────────────────────────────────────────────────────

exports.getConfig = functions.https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        return res.status(200).json({
            MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY
        });
    });
});

exports.createCheckoutSession = functions.runWith({
    timeoutSeconds: 60,
    memory: '256MB'
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const client = getMercadoPagoClient();
        if (!client) return res.status(500).json({ error: 'MP not configured' });
        try {
            const { items, customer, zipCode, shippingCost: clientShippingCost } = req.body;

            // 1. Use the pre-calculated shipping cost from the client (from getShippingQuote call)
            //    If not provided, fall back to 0 (CT covers it in dropshipping price)
            const destinoCp = zipCode || '64000';
            const shippingCost = typeof clientShippingCost === 'number' ? clientShippingCost : 0;

            // 2. Array de items para Mercado Pago
            const preferenceItems = items.map(p => ({
                id: p.sku || 'SKU', title: p.name, quantity: p.quantity, unit_price: Number(p.price), currency_id: 'MXN'
            }));

            // 3. Add shipping as a separate MP line item (only if > 0)
            if (shippingCost > 0) {
                preferenceItems.push({ id: 'ENVIO', title: 'Envío CT DropShipping', quantity: 1, unit_price: shippingCost, currency_id: 'MXN' });
            }

            const amountTotal = items.reduce((s, i) => s + (i.price * i.quantity), 0) + shippingCost;

            const now = new Date();
            const yearStr = now.getFullYear().toString();
            const monthStr = (now.getMonth() + 1).toString().padStart(2, '0');
            const orderRef = admin.firestore().collection('orders').doc(yearStr).collection(monthStr).doc();

            await orderRef.set({
                status: 'pending_payment',
                createdAt: FieldValue.serverTimestamp(),
                customerInfo: customer,
                shippingInfo: {
                    zipCode: destinoCp,
                    cost: shippingCost,
                    provider: 'CT'
                },
                items,
                amountTotal: amountTotal
            });

            const preference = new MPPreference(client);
            const response = await preference.create({
                body: {
                    items: preferenceItems,
                    payer: { email: customer.email, name: customer.name },
                    back_urls: {
                        success: `${YOUR_DOMAIN}/success.html`,
                        failure: `${YOUR_DOMAIN}/failure.html`,
                        pending: `${YOUR_DOMAIN}/pending.html`
                    },
                    auto_return: 'approved',
                    external_reference: `${yearStr}/${monthStr}/${orderRef.id}`,
                    notification_url: 'https://us-central1-pandishu-web-1d860.cloudfunctions.net/mpWebhook'
                }
            });
            return res.status(200).json({ url: response.init_point });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

exports.processPayment = functions.runWith({
    timeoutSeconds: 60,
    memory: '256MB'
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const client = getMercadoPagoClient();
        const { token, payment_method_id, installments, issuer_id, customer, items, zipCode } = req.body;

        try {
            // 1. Costo base de los items
            let amount = items.reduce((s, i) => s + (i.price * i.quantity), 0);

            // 2. Envío gestionado por CT
            const destinoCp = zipCode || '64000';
            const shippingCost = 0;

            // 3. Sumar el costo al monto a cobrar en la tarjeta
            amount += shippingCost;

            const now = new Date();
            const yearStr = now.getFullYear().toString();
            const monthStr = (now.getMonth() + 1).toString().padStart(2, '0');
            const orderRef = admin.firestore().collection('orders').doc(yearStr).collection(monthStr).doc();

            await orderRef.set({
                status: 'processing',
                customerInfo: customer,
                shippingInfo: {
                    zipCode: destinoCp,
                    cost: shippingCost,
                    provider: 'CT'
                },
                items,
                amountTotal: amount,
                createdAt: FieldValue.serverTimestamp()
            });

            const payment = new MPPayment(client);
            const response = await payment.create({
                body: {
                    transaction_amount: amount,
                    token,
                    description: 'Compra Pandishu',
                    installments: Number(installments),
                    payment_method_id,
                    issuer_id,
                    payer: { email: customer.email },
                    external_reference: `${yearStr}/${monthStr}/${orderRef.id}`
                }
            });

            await orderRef.update({ mpStatus: response.status, mpPaymentId: response.id });
            if (response.status === 'approved') {
                await enviarCorreoConfirmacion(customer.email, customer.name, orderRef.id, items, amount);
            }
            return res.status(200).json(response);
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});



exports.mpWebhook = functions.runWith({ timeoutSeconds: 120, memory: '512MB' }).https.onRequest(async (req, res) => {
    const client = getMercadoPagoClient();
    const paymentId = req.query.id || (req.body.data && req.body.data.id);
    if (!paymentId) return res.status(200).send('OK');

    try {
        const mpPayment = new MPPayment(client);
        const payInfo = await mpPayment.get({ id: paymentId });
        const orderId = payInfo.external_reference;

        if (payInfo.status === 'approved' && orderId) {
            const orderRef = admin.firestore().collection('orders').doc(orderId);
            const orderDoc = await orderRef.get();

            if (orderDoc.exists && orderDoc.data().status !== 'paid') {
                const data = orderDoc.data();

                // 1. Asignar almacén CT óptimo y agrupar (Only for CT)
                const { getCTItemStock, createCTOrder, confirmCTOrder } = require('./services/ctConnect');
                const { getOptimalWarehouse } = require('./services/warehouseManager');

                let resolvedItems = [];
                let ctOrdersLog = [];
                const warehouseGroups = {};

                try {
                    const token = await getCTToken();

                    for (let item of data.items) {
                        if (item.source === 'CT' || !item.vendorName || item.vendorName === 'CT') {
                            const ctStock = await getCTItemStock(item.sku, token);
                            const bestAlmacen = getOptimalWarehouse(data.shippingInfo.zipCode, ctStock);
                            const assignedItem = { ...item, assignedWarehouse: bestAlmacen || 'PENDING' };
                            resolvedItems.push(assignedItem);

                            if (bestAlmacen) {
                                if (!warehouseGroups[bestAlmacen]) warehouseGroups[bestAlmacen] = [];
                                warehouseGroups[bestAlmacen].push(assignedItem);
                            }
                        } else {
                            resolvedItems.push(item);
                        }
                    }

                    // 2. Por cada almacén, generar un pedido CT independiente
                    for (const almacen in warehouseGroups) {
                        const itemsForAlmacen = warehouseGroups[almacen];

                        const ctPartidas = itemsForAlmacen.map(i => ({
                            cantidad: i.quantity,
                            clave: i.sku,
                            precio: parseFloat(i.price),
                            moneda: 'MXN'
                        }));

                        // Unique CT internal ID using timestamp + random
                        const uniqueOrderId = parseInt(Date.now().toString().slice(-8) + Math.floor(Math.random() * 100), 10);
                        const customer = data.customerInfo || {};
                        const address = customer.address || {};

                        const zipCheck = (address.zip || data.shippingInfo?.zipCode || '06000').toString().replace(/\D/g, '');
                        const phoneCheck = (customer.phone || '0000000000').toString().replace(/\D/g, '');

                        const ctEnvio = {
                            nombre: customer.name || "Cliente Final",
                            direccion: address.street || "Conocido",
                            entreCalles: address.notes || "",
                            noExterior: address.ext_number || "S/N",
                            noInterior: address.int_number || "",
                            colonia: address.colonia || address.neighborhood || "Centro",
                            estado: address.state || "CMX",
                            ciudad: address.city || "Ciudad de Mexico",
                            codigoPostal: parseInt(zipCheck) || 0,
                            telefono: parseInt(phoneCheck) || 0
                        };

                        const ctOrderPayload = {
                            idPedido: uniqueOrderId,
                            almacen: almacen,
                            tipoPago: "99",
                            cfdi: "G03",
                            envio: [ctEnvio],
                            partidas: ctPartidas
                        };

                        // 3. Crear y Confirmar Pedido en CT DropShipping
                        const placedOrder = await createCTOrder(ctOrderPayload, token);
                        if (placedOrder && placedOrder.respuesta === 'ok') {
                            const ctFolio = placedOrder.pedidoWeb;
                            const confirmedOrder = await confirmCTOrder(ctFolio, token);

                            ctOrdersLog.push({
                                almacen: almacen,
                                pedidoWeb: ctFolio,
                                subOrderId: uniqueOrderId,
                                status: (confirmedOrder && confirmedOrder.respuesta === 'ok') ? 'confirmed' : 'placed_needs_confirmation',
                                items: ctPartidas.map(i => i.clave)
                            });
                        } else {
                            console.error(`Fallo CT para almacen ${almacen}:`, placedOrder);
                            ctOrdersLog.push({ almacen, status: 'failed', error: placedOrder });
                        }
                    }

                } catch (err) {
                    console.error("Error procesando CT Dropshipping en Webhook:", err);
                }

                // ── Mark order as PAID immediately (never lose the payment record) ──
                await orderRef.update({
                    status: 'paid',
                    mpPaymentId: paymentId,
                    paidAt: FieldValue.serverTimestamp(),
                    items: resolvedItems,
                    ctOrders: ctOrdersLog
                });

                // ── Send purchase confirmation email right away ──
                await enviarCorreoConfirmacion(data.customerInfo.email, data.customerInfo.name, orderId, resolvedItems, data.amountTotal);

                // ── Launch Antigravity OS v2.0 Fulfillment Loop ────────────────
                // (volumetry → SkydropX label → CT guias → shipped status → tracking email)
                console.log('[Webhook] Starting Antigravity OS v2.0 fulfillment loop...');
                runFulfillmentLoop(
                    { ...data, items: resolvedItems },
                    ctOrdersLog,
                    orderRef
                ).then(result => {
                    console.log('[Webhook] Fulfillment loop completed:', result?.trackingResult?.number || 'no tracking');
                }).catch(err => {
                    console.error('[Webhook] Fulfillment loop error (order already saved):', err.message);
                });
            }
        }
        return res.status(200).send('OK');
    } catch (e) { return res.status(200).send('OK'); }
});

let cachedCTCatalog = null;
let cachedBrands = [];
let lastCatalogFetch = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hr cache

exports.searchProducts = functions.runWith({ timeoutSeconds: 60, memory: '1GB' }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const db = admin.firestore();

            const FX_BUFFER = 1.05;
            const UTILITY_MARGIN = 1.15;

            // Ensure Amazon keywords are loaded for scoring
            if (!amazonKeywordsLoaded) {
                await loadAmazonTopKeywords();
            }

            if (!cachedCTCatalog || Date.now() - lastCatalogFetch > CACHE_TTL) {
                console.log('Fetching ct_catalog from Firestore to build memory cache...');
                const ctSnap = await db.collection('ct_catalog').get();

                const brandsSet = new Set();
                cachedCTCatalog = ctSnap.docs.map(d => {
                    const data = { ...d.data() };
                    const stock = parseInt(data.availability?.availableQuantity || data.existencia || 0, 10);

                    const basePrice = parseFloat(data.price) || 0;
                    let finalPrice = basePrice * FX_BUFFER * UTILITY_MARGIN;

                    delete data.costoInterno;
                    delete data.gananciaBruta;
                    delete data.margenUtilidad;
                    delete data.costo;
                    delete data.precioPromocion;

                    const vendorName = data.vendorName || data.brand || 'CT';
                    if (vendorName) brandsSet.add(vendorName.trim());

                    return {
                        ...data,
                        price: finalPrice,
                        source: 'CT',
                        vendorName: vendorName,
                        stock
                    };
                });

                cachedBrands = Array.from(brandsSet).sort((a, b) => a.localeCompare(b));
                lastCatalogFetch = Date.now();
                console.log(`Cache updated. ${cachedCTCatalog.length} products loaded. ${cachedBrands.length} brands.`);
            }

            const products = cachedCTCatalog;
            const keyword = (req.body.keyword || '').toLowerCase();
            const brandFilters = req.body.brands || [];
            const topVentas = req.body.topVentas === true; // Flag from homepage

            // 1. Filter phase
            let filtered = products;

            if (brandFilters.length > 0) {
                filtered = filtered.filter(p => brandFilters.includes(p.vendorName.trim()));
            }

            if (keyword) {
                // Smart fuzzy search: normalize input, expand brand aliases, strip accents
                const searchTerms = resolveSearchTerms(keyword);
                filtered = filtered.filter(p => productMatchesSearch(p, searchTerms));
            }

            // 2. Score-based sort (Relevancia = Stock + Price + Amazon Boost)
            // Pre-compute scores to avoid redundant calls in sort comparator
            const withScores = filtered.map(p => ({ p, score: calcProductScore(p) }));
            withScores.sort((a, b) => b.score - a.score);
            const sorted = withScores.map(x => x.p);

            // 3. topVentas mode: for the Index homepage, only return products with good availability
            //    and a meaningful price (not cheap accessories), limit to top 12
            let finalFiltered = sorted;
            if (topVentas) {
                finalFiltered = sorted.filter(p => p.stock > 5 && (p.price || 0) > 500);
            }

            // Pagination defaults to 48 items (12 for topVentas)
            const limit = topVentas ? 12 : (parseInt(req.body.limit) || 48);
            const page = parseInt(req.body.page) || 1;
            const startIndex = (page - 1) * limit;

            const finalResults = finalFiltered.slice(startIndex, startIndex + limit);

            return res.status(200).json({
                recordsFound: finalFiltered.length,
                catalog: finalResults,
                brands: cachedBrands,
                page,
                totalPages: Math.ceil(finalFiltered.length / limit)
            });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

exports.getPriceAndAvailability = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        const { skus } = req.body;
        const token = await getCTToken();
        const results = await Promise.all(skus.map(async (sku) => {
            const response = await fetch(`${CT_API_BASE}/existencia/promociones/${sku}`, { headers: { 'x-auth': token } });
            if (!response.ok) return null;
            const data = await response.json();
            return {
                ingramPartNumber: sku,
                pricing: { customerPrice: data.precio, currencyCode: data.moneda },
                availability: { totalAvailability: (data.almacenes || []).reduce((s, a) => s + (a.existencia || 0), 0) }
            };
        }));
        return res.status(200).json(results.filter(r => r));
    });
});

// ─── HELPER: CT FTP catalog ingestion (used by HTTP endpoint + scheduled function) ─
async function runCTCatalogSync() {
    const ftp = require('basic-ftp');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const localPath = path.join(os.tmpdir(), 'ct_catalog.json');

    const client = new ftp.Client();
    // client.ftp.verbose = true; // Uncomment to debug FTP protocol

    try {
        console.log('[CT Sync] Conectando al FTP de CT Internacional...');
        await client.access({
            host: '216.70.82.104',
            user: process.env.CT_FTP_USER || 'DFP2631',
            password: process.env.CT_FTP_PASSWORD || 'hMlrhbEAvy0ungi3UxsvFkQtHmHtYyy5',
            port: 21,
            secure: false
        });

        // CT FTP always puts the catalog at this fixed path
        const remotePath = '/catalogo_xml/productos.json';
        console.log(`[CT Sync] Descargando ${remotePath}...`);
        await client.downloadTo(localPath, remotePath);
        console.log('[CT Sync] Descarga completa.');
    } finally {
        client.close();
    }

    const raw = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const productArray = Array.isArray(raw) ? raw : (raw.productos || []);
    console.log(`[CT Sync] ${productArray.length} productos en el feed.`);

    const mapped = productArray.map(p => {
        let totalStock = 0;
        let almacenesStock = {};

        if (typeof p.existencia === 'object' && p.existencia !== null) {
            almacenesStock = p.existencia;
            totalStock = Object.values(p.existencia).reduce((sum, val) => sum + (parseInt(val, 10) || 0), 0);
        } else {
            totalStock = parseInt(p.existencia || p.disponible || 0, 10) || 0;
        }

        let promoPrice = null;
        if (p.promocion && p.promocion.precio) {
            promoPrice = parseFloat(p.promocion.precio) * (p.moneda === 'USD' ? MXN_RATE : 1);
        }

        return {
            ingramPartNumber: String(p.clave || p.codigo || ''),
            description: p.nombre || '',
            price: parseFloat(p.precio || 0) * (p.moneda === 'USD' ? MXN_RATE : 1),
            precioPromocion: promoPrice,
            currency: 'MXN',
            image: (p.imagen || '').replace(/^http:\/\//i, 'https://'),
            vendorName: p.marca || p.fabricante || p.brand || '',
            existencia: totalStock,
            almacenes: almacenesStock,
            availability: { availableQuantity: totalStock }
        };
    }).filter(p => p.ingramPartNumber);

    console.log(`[CT Sync] ${mapped.length} productos válidos. Guardando en Firestore...`);
    const db = admin.firestore();
    for (let i = 0; i < mapped.length; i += 400) {
        const batch = db.batch();
        mapped.slice(i, i + 400).forEach(p => batch.set(db.collection('ct_catalog').doc(p.ingramPartNumber), p, { merge: true }));
        await batch.commit();
    }

    // Invalidate in-memory cache so next API call reloads fresh data
    cachedCTCatalog = null;
    lastCatalogFetch = 0;

    console.log(`[CT Sync] ✅ Sync completo. ${mapped.length} productos sincronizados.`);
    return { count: mapped.length };
}

// ─── HTTP ENDPOINT (manual trigger) ───────────────────────────────────────────
exports.syncCTCatalog = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        try {
            const result = await runCTCatalogSync();
            return res.status(200).json({ success: true, ...result });
        } catch (e) {
            console.error('[CT Sync] Error:', e.message);
            return res.status(500).json({ error: e.message });
        }
    });
});

// ─── SCHEDULED FUNCTION: Sync CT catalog every day at 2 AM Mexico City ────────
exports.scheduledCTCatalogSync = functions.runWith({ timeoutSeconds: 540, memory: '512MB' })
    .pubsub.schedule('0 2 * * *')
    .timeZone('America/Mexico_City')
    .onRun(async (context) => {
        console.log('[CT Sync Scheduled] Iniciando sync diario del catálogo CT...');
        try {
            const result = await runCTCatalogSync();
            console.log(`[CT Sync Scheduled] ✅ Completado: ${result.count} productos.`);
        } catch (e) {
            console.error('[CT Sync Scheduled] ❌ Error:', e.message);
        }
        return null;
    });

// ─── AMAZON TOP SELLERS SCRAPER ───────────────────────────────────────────────
/**
 * Scrapes Amazon Mexico Best Sellers pages (Electronics + Computing).
 * Extracts product titles and brands, builds keyword list.
 * Stores in Firestore 'top_sellers_index' collection.
 * Runs every Monday at 3 AM Mexico City time.
 */
async function runAmazonTopSellersScrape() {
    const axios = require('axios');
    const db = admin.firestore();

    const AMAZON_CATEGORIES = [
        { id: 'laptops', url: 'https://www.amazon.com.mx/gp/bestsellers/computers/3380503011' },
        { id: 'networking', url: 'https://www.amazon.com.mx/gp/bestsellers/computers/3380512011' },
        { id: 'monitors', url: 'https://www.amazon.com.mx/gp/bestsellers/computers/3380561011' },
        { id: 'tablets', url: 'https://www.amazon.com.mx/gp/bestsellers/electronics/13786801' },
        { id: 'cameras', url: 'https://www.amazon.com.mx/gp/bestsellers/electronics/3380530011' },
        { id: 'printers', url: 'https://www.amazon.com.mx/gp/bestsellers/computers/3380525011' },
        { id: 'storage', url: 'https://www.amazon.com.mx/gp/bestsellers/computers/3380546011' },
    ];

    // Known tech brands for cross-referencing with CT catalog
    const TECH_BRANDS = [
        'hp', 'dell', 'lenovo', 'asus', 'acer', 'apple', 'samsung', 'lg',
        'tp-link', 'tplink', 'ubiquiti', 'cisco', 'netgear', 'dlink', 'd-link',
        'corsair', 'kingston', 'seagate', 'western digital', 'wd', 'sandisk',
        'epson', 'canon', 'brother', 'hikvision', 'logitech', 'intel', 'amd',
        'nvidia', 'msi', 'gigabyte', 'microsoft', 'xerox', 'toshiba', 'viewsonic',
        'benq', 'anker', 'belkin', 'razer'
    ];

    const extractedKeywords = new Set();
    let successCount = 0;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-MX,es;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache'
    };

    for (const category of AMAZON_CATEGORIES) {
        try {
            console.log(`[AmazonScraper] Scraping: ${category.id}...`);
            const response = await axios.get(category.url, { headers, timeout: 15000 });
            const html = response.data;

            // Extract product titles from Amazon bestsellers grid
            // Pattern matches the title spans in best seller cards
            const titleMatches = html.match(/class="[^"]*p13n-sc-truncate[^"]*"[^>]*>([^<]{3,80})</g) || [];
            const altMatches = html.match(/aria-label="([^"]{5,100})"/g) || [];

            const allTitles = [
                ...titleMatches.map(m => m.replace(/.*>/, '').trim()),
                ...altMatches.map(m => m.replace('aria-label="', '').replace('"', '').trim())
            ];

            allTitles.forEach(title => {
                const lowerTitle = title.toLowerCase();
                // Add known brand names found in titles
                TECH_BRANDS.forEach(brand => {
                    if (lowerTitle.includes(brand)) {
                        extractedKeywords.add(brand);
                    }
                });
                // Extract meaningful model keywords (uppercase words, likely model numbers)
                const modelWords = title.match(/\b[A-Z][A-Z0-9-]{2,}\b/g) || [];
                modelWords.forEach(word => {
                    if (word.length >= 3 && word.length <= 15) {
                        extractedKeywords.add(word.toLowerCase());
                    }
                });
                // Extract full product category terms (2-4 word phrases)
                const catTerms = [
                    'laptop', 'notebook', 'router', 'switch', 'monitor', 'teclado', 'mouse',
                    'impresora', 'disco duro', 'ssd', 'cámara ip', 'nvr', 'servidor', 'tablet',
                    'access point', 'disco ssd', 'ram', 'memoria', 'pantalla', 'webcam',
                    'auriculares', 'headset', 'ups', 'no break', 'proyector', 'scanner'
                ];
                catTerms.forEach(term => {
                    if (lowerTitle.includes(term)) extractedKeywords.add(term);
                });
            });

            successCount++;
            console.log(`[AmazonScraper] ✅ ${category.id}: ${allTitles.length} titles scraped.`);

            // Be polite to Amazon's servers
            await new Promise(r => setTimeout(r, 1500));

        } catch (err) {
            console.warn(`[AmazonScraper] ⚠️ Failed ${category.id}: ${err.message}`);
        }
    }

    // Save to Firestore top_sellers_index collection
    const keywords = Array.from(extractedKeywords);
    console.log(`[AmazonScraper] Saving ${keywords.length} keywords from ${successCount} categories...`);

    await db.collection('top_sellers_index').doc('amazon_mx').set({
        keywords,
        updatedAt: FieldValue.serverTimestamp(),
        successCategories: successCount,
        totalCategories: AMAZON_CATEGORIES.length
    });

    // Invalidate in-memory Amazon keywords cache so next search uses fresh data
    amazonKeywordsLoaded = false;

    console.log(`[AmazonScraper] ✅ Done. ${keywords.length} keywords saved.`);
    return { keywords: keywords.length, successCount };
}

// Scheduled: every Monday at 3 AM Mexico City
exports.scheduledAmazonTopSellers = functions.runWith({ timeoutSeconds: 300, memory: '256MB' })
    .pubsub.schedule('0 3 * * 1')
    .timeZone('America/Mexico_City')
    .onRun(async (context) => {
        console.log('[AmazonScraper] Iniciando scrape semanal de Amazon Top Sellers...');
        try {
            const result = await runAmazonTopSellersScrape();
            console.log(`[AmazonScraper] ✅ Scrape completado: ${result.keywords} keywords.`);
        } catch (e) {
            console.error('[AmazonScraper] ❌ Error:', e.message);
        }
        return null;
    });

// HTTP endpoint to trigger Amazon scrape manually (admin only)
exports.triggerAmazonScrape = functions.runWith({ timeoutSeconds: 300, memory: '256MB' }).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        const adminKey = req.headers['x-admin-key'] || req.body?.adminKey;
        const masterKey = process.env.ADMIN_SECRET_KEY;
        if (!adminKey || adminKey !== masterKey) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        try {
            const result = await runAmazonTopSellersScrape();
            return res.status(200).json({ success: true, ...result });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });
});


// Eliminado syncIngramCatalog para dar paso exclusivo a CT Connect

// ─── ORDER DASHBOARD (GET PEDIDOS) ────────────────────────────────────────────
exports.getPedidos = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            // -- TEMP PROXY TEST
            if (req.body && req.body.testProxy) {
                const axios = require('axios');
                const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;

                const proxyUrl = process.env.PROXY_URL;
                const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

                const noProxyRes = await axios.get('https://api.ipify.org?format=json');

                const proxyRes = await axios.get('https://api.ipify.org?format=json', {
                    httpAgent: proxyAgent,
                    httpsAgent: proxyAgent
                });

                return res.status(200).json({
                    success: true,
                    ip_normal_cloud_nat: noProxyRes.data.ip,
                    ip_tunnel_squid_vm: proxyRes.data.ip
                });
            }

            const { year, month, adminKey } = req.body;
            // Seguridad básica para evitar acceso público a datos de ventas
            const masterKey = process.env.ADMIN_SECRET_KEY || process.env.INGRAM_SECRET_KEY; // Fallback temporal hasta actualizar env vars
            const providedKey = adminKey || req.headers['x-admin-key'];

            if (!providedKey || providedKey !== masterKey) {
                console.warn('[Security] Intento de acceso no autorizado a getPedidos');
                return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
            }

            if (!year || !month) return res.status(400).json({ error: 'Falta year y month en body' });

            const monthStr = month.toString().padStart(2, '0');
            const ordersRef = admin.firestore().collection('orders').doc(year.toString()).collection(monthStr);
            const snap = await ordersRef.orderBy('createdAt', 'desc').get();

            const pedidos = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return res.status(200).json({ recordsFound: pedidos.length, pedidos });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });
});

// ─── GROWTH MARKETING: LEAD MAGNET WELCOME EMAIL ─────────────────────────────
exports.onLeadCreated = functions.firestore
    .document('newsletter_leads/{docId}')
    .onCreate(async (snap, context) => {
        const lead = snap.data();
        const transporter = getMailTransporter();
        if (!transporter) {
            console.error("Transporter SMTP no configurado.");
            return;
        }

        const mailOptions = {
            from: '"Pandishú Premium Hardware" <pandipandishu@gmail.com>', // Coincide con SMTP_EMAIL por defecto o process.env
            to: lead.correo,
            subject: '🚀 Bienvenido a Pandishú Tech Updates',
            html: `
            <div style="font-family: sans-serif; background-color: #020617; color: #f8fafc; padding: 40px 20px;">
                <div style="max-width: 600px; margin: 0 auto; background: #0f172a; border: 1px solid #d946ef; border-radius: 16px; padding: 30px; box-shadow: 0 0 20px rgba(217, 70, 239, 0.2);">
                    <h1 style="color: #d946ef; text-align: center; font-style: italic; letter-spacing: 2px;">PANDISHÚ</h1>
                    <h2 style="text-align: center;">¡Hola ${lead.nombre}! Bienvenido a la Elite Tech</h2>
                    
                    <p style="color: #cbd5e1; line-height: 1.6; text-align: center;">Gracias por suscribirte. Estás oficialmente en la lista VIP para recibir las mejores tendencias en Redes Enterprise, descubrimientos en Ciberseguridad IA y lanzamientos de Hardware High-End.</p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="https://pandishu.com/documentos/Checklist_2026_PC_Gamer.pdf" style="background-color: #d946ef; color: white; padding: 15px 25px; text-decoration: none; font-weight: bold; border-radius: 8px; display: inline-block;">📥 Descargar Checklist 2026</a>
                    </div>
                    
                    <hr style="border: 0; height: 1px; background: linear-gradient(90deg, transparent, #d946ef, transparent); margin: 30px 0;">
                    
                    <h3 style="color: #38bdf8;">¿Sabías qué? ⚡ Entrega Inmediata en CDMX</h3>
                    <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
                        No esperes semanas por tu hardware. En Pandishú operamos los almacenes corporativos más robustos del país. 
                        <strong>Si compras antes de las 12 PM, recibe tus componentes el MISMO DÍA, o te ensamblamos la PC a domicilio en toda la CDMX.</strong>
                    </p>
                    <p style="text-align: center; font-size: 12px; color: #475569; margin-top: 40px;">
                        Has recibido esto porque te suscribiste a nuestro boletín.<br> 
                        Pandishú Tech Solutions | CDMX
                    </p>
                </div>
            </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`Email de Lead Magnet enviado exitosamente a ${lead.correo}`);
        } catch (error) {
            console.error(`Fallo al enviar el correo a ${lead.correo}:`, error);
        }
    });

// ─── CUSTOMER ORDER LOOKUP (PUBLIC) ───────────────────────────────────────────
exports.getOrderStatus = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const { email, orderId } = req.body;

            if (!email && !orderId) {
                return res.status(400).json({ error: 'Se requiere el correo electrónico o el número de pedido.' });
            }

            const db = admin.firestore();
            const now = new Date();
            const foundOrders = [];

            const buildOrderPayload = (docId, data) => ({
                orderId: docId,
                status: data.status,
                createdAt: data.createdAt,
                paidAt: data.paidAt || null,
                amountTotal: data.amountTotal,
                items: (data.items || []).map(item => ({
                    name: item.name,
                    quantity: item.quantity,
                    sku: item.sku
                })),
                ctOrders: (data.ctOrders || []).map(ct => ({
                    pedidoWeb: ct.pedidoWeb,
                    status: ct.status,
                    almacen: ct.almacen
                }))
            });

            for (let i = 0; i < 6; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const year = d.getFullYear().toString();
                const month = (d.getMonth() + 1).toString().padStart(2, '0');
                const colRef = db.collection('orders').doc(year).collection(month);

                try {
                    if (orderId) {
                        // Lookup by specific orderId
                        const docSnap = await colRef.doc(orderId).get();
                        if (docSnap.exists) {
                            foundOrders.push(buildOrderPayload(docSnap.id, docSnap.data()));
                            break; // Found it, stop scanning
                        }
                    } else {
                        // Lookup all orders by email
                        const normalizedEmail = email.toLowerCase().trim();
                        const snap = await colRef
                            .where('customerInfo.email', '==', normalizedEmail)
                            .orderBy('createdAt', 'desc')
                            .limit(10)
                            .get();
                        snap.forEach(doc => foundOrders.push(buildOrderPayload(doc.id, doc.data())));
                    }
                } catch (queryErr) {
                    console.warn(`Skipping ${year}/${month}:`, queryErr.message);
                }
            }

            if (foundOrders.length === 0) {
                return res.status(404).json({ error: 'Pedido no encontrado. Verifica el número de pedido o el correo.' });
            }

            return res.status(200).json({ orders: foundOrders });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });
});
