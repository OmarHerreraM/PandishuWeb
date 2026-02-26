'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const cors = require('cors')({ origin: true });
const XiSdk = require('xi_sdk_resellers');
const nodemailer = require('nodemailer');

admin.initializeApp();

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
    if (doc.exists && doc.data().token) {
        return doc.data().token;
    }
    // Fallback: Generate it right now if it doesn't exist
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

// ─── SERVICIOS DE ENVÍO ────────────────────────────────────────────────────────
const { getSkydropxQuoteForCart } = require('./services/shipping');

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

// ─── MERCADO PAGO CONFIG ──────────────────────────────────────────────────────
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
            MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY || 'TEST-2f0becf0-afe4-4c79-bea8-317ccc152d84'
        });
    });
});

exports.createCheckoutSession = functions.runWith({
    timeoutSeconds: 60,
    memory: '256MB',
    secrets: ['SKYDROPX_CLIENT_ID', 'SKYDROPX_CLIENT_SECRET']
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const client = getMercadoPagoClient();
        if (!client) return res.status(500).json({ error: 'MP not configured' });
        try {
            const { items, customer, zipCode } = req.body;

            // 1. Array de items base para Mercado Pago
            const preferenceItems = items.map(p => ({
                id: p.sku || 'SKU', title: p.name, quantity: p.quantity, unit_price: Number(p.price), currency_id: 'MXN'
            }));

            // 2. Calcular tarifa dinámica de envío (Fallback a zip default general '64000' Monterrey si no lo envían)
            const destinoCp = zipCode || '64000';
            console.log(`Calculando envío para CP: ${destinoCp} con Skydropx...`);
            const shippingCost = await getSkydropxQuoteForCart(destinoCp, items);

            // 3. Añadir el costo de envío a los items que el cliente pagará
            preferenceItems.push({ id: 'ENVIO', title: 'Costo de Envío (SkydropX)', quantity: 1, unit_price: shippingCost, currency_id: 'MXN' });

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
                    provider: 'SkydropX'
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
    memory: '256MB',
    secrets: ['SKYDROPX_CLIENT_ID', 'SKYDROPX_CLIENT_SECRET']
}).https.onRequest((req, res) => {
    cors(req, res, async () => {
        const client = getMercadoPagoClient();
        const { token, payment_method_id, installments, issuer_id, customer, items, zipCode } = req.body;

        try {
            // 1. Costo base de los items
            let amount = items.reduce((s, i) => s + (i.price * i.quantity), 0);

            // 2. Calcular envío de la misma manera que en la preferencia
            const destinoCp = zipCode || '64000';
            console.log(`Calculando envío directo para pago (CP: ${destinoCp}) con SkydropX...`);
            const shippingCost = await getSkydropxQuoteForCart(destinoCp, items);

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
                    provider: 'SkydropX'
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

exports.mpWebhook = functions.https.onRequest(async (req, res) => {
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
                await orderRef.update({ status: 'paid', mpPaymentId: paymentId, paidAt: FieldValue.serverTimestamp() });
                const data = orderDoc.data();
                await enviarCorreoConfirmacion(data.customerInfo.email, data.customerInfo.name, orderId, data.items, data.amountTotal);
            }
        }
        return res.status(200).send('OK');
    } catch (e) { return res.status(200).send('OK'); }
});

exports.searchProducts = functions.runWith({ timeoutSeconds: 60, memory: '1GB' }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const db = admin.firestore();

            // TEMPORARY: disabled Ingram until images are provided
            const ctSnap = await db.collection('ct_catalog').get();

            const ctProducts = ctSnap.docs.map(d => {
                const data = { ...d.data() };
                const stock = data.availability?.availableQuantity || data.existencia || 0;
                delete data.costoInterno;
                delete data.gananciaBruta;
                delete data.margenUtilidad;
                delete data.costo;
                return { ...data, source: 'CT', vendorName: data.vendorName || 'CT', stock };
            });

            const products = [...ctProducts];

            const keyword = (req.body.keyword || '').toLowerCase();
            const filtered = keyword ? products.filter(p => (p.description || '').toLowerCase().includes(keyword) || (p.sku || '').toLowerCase().includes(keyword)) : products;

            return res.status(200).json({ recordsFound: filtered.length, catalog: filtered });
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

exports.syncCTCatalog = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).https.onRequest(async (req, res) => {
    cors(req, res, async () => {
        const ftp = require('basic-ftp');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const client = new ftp.Client();
        const localPath = path.join(os.tmpdir(), 'ct_stock.json');

        try {
            await client.access({ host: '216.70.82.104', user: process.env.CT_FTP_USER, password: process.env.CT_FTP_PASSWORD });
            await client.cd('catalogo_xml');
            const list = await client.list();
            const jsonFile = list.find(f => f.name.toLowerCase().endsWith('.json'));
            await client.downloadTo(localPath, jsonFile.name);
            client.close();

            const products = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            const productArray = Array.isArray(products) ? products : (products.productos || []);
            const mapped = productArray.map(p => ({
                ingramPartNumber: String(p.clave || p.codigo || ''),
                description: p.nombre || '',
                price: parseFloat(p.precio) * (p.moneda === 'USD' ? MXN_RATE : 1),
                currency: 'MXN',
                image: p.imagen || '',
                availability: { availableQuantity: parseInt(p.existencia || 0) }
            })).filter(p => p.ingramPartNumber);

            const db = admin.firestore();
            for (let i = 0; i < mapped.length; i += 400) {
                const batch = db.batch();
                mapped.slice(i, i + 400).forEach(p => batch.set(db.collection('ct_catalog').doc(p.ingramPartNumber), p));
                await batch.commit();
            }
            return res.status(200).json({ success: true, count: mapped.length });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    });
});

// ─── ORDER DASHBOARD (GET PEDIDOS) ────────────────────────────────────────────
exports.getPedidos = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            const { year, month } = req.body;
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
