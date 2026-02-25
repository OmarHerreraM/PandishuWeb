/**
 * probeCTEndpoints.js - Probing available CT Connect endpoints
 * Runs locally to find the correct catalog API path.
 */
require('dotenv').config();

const CT_BASE = process.env.CT_API_BASE || 'http://connect.ctonline.mx:3001';
const CT_CLIENT = process.env.CT_CLIENT_NUMBER;
const CT_EMAIL = process.env.CT_EMAIL;
const CT_RFC = process.env.CT_RFC;

async function getToken() {
    const res = await fetch(`${CT_BASE}/cliente/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: CT_EMAIL, cliente: CT_CLIENT, rfc: CT_RFC })
    });
    if (!res.ok) throw new Error(`Token error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.token;
}

const pathsToTest = [
    '/existencia/promociones',
    '/productos',
    '/catalogo',
    '/products',
    '/inventario',
    '/existencia',
    '/articulos',
];

async function probe() {
    console.log(`CT Base: ${CT_BASE}`);
    console.log('Getting token...');
    const token = await getToken();
    console.log(`Token OK: ${token.substring(0, 30)}...\n`);

    for (const path of pathsToTest) {
        const url = `${CT_BASE}${path}`;
        try {
            const res = await fetch(url, { headers: { 'x-auth': token } });
            console.log(`  ${res.status}  GET ${path}`);
        } catch (e) {
            console.log(`  ERR  GET ${path}: ${e.message}`);
        }
    }
}

probe().catch(console.error);
