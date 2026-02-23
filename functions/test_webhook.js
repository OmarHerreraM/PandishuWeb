const crypto = require('crypto');
const fetch = require('node-fetch');

// Debes poner aquí el mismo valor que tienes en funciones/.env o un mock para la prueba local
const MOCK_SECRET = 'MOCK_SECRET_TESTING123';
const EMULATOR_URL = 'http://127.0.0.1:5001/pandishu-web-1d860/us-central1/ingramWebhook';

async function testWebhook() {
    console.log("Generando firma local HMAC-SHA512...");

    // Simular el payload de Ingram (Stock Update)
    const payload = {
        topic: "resellers/catalog",
        event: "im::updated",
        eventId: "TEST-EVENT-ID-001",
        resource: [
            {
                eventType: "IM::STOCK_UPDATE",
                ingramPartNumber: "MOCK-UBI-01",
                totalAvailability: "99"
            }
        ]
    };

    // Generar la firma esperada usando el MOCK_SECRET
    const hmac = crypto.createHmac('sha512', MOCK_SECRET);
    hmac.update(payload.eventId, 'utf-8');
    const signatureBase64 = hmac.digest('base64');

    console.log("Firma generada:", signatureBase64);

    try {
        console.log("Enviando webhook al emulador...");
        // Modificar temporalmente PROCESS.ENV no funciona aquí para el emulador porque corre en otro proceso.
        // Asume que el emulador tiene acceso a un string o si no arrojará warning por la firma (pero no fallará).
        const res = await fetch(EMULATOR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hub-signature': signatureBase64,
                // enviamos header custom simulando tener el mismo secret si quisieramos inyectar variables, pero dependera del .env del emulador
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        console.log("Status:", res.status);
        console.log("Response:", data);
    } catch (err) {
        console.error("Error en test Webhook:", err);
    }
}

testWebhook();
