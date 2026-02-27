const fs = require('fs');
const readline = require('readline');
const admin = require('firebase-admin');

// 1. Inicializar Firebase si no se ha hecho
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Script Profesional para Procesar Catálogos de Proveedores
 * Extrae SKU (2), PVP (7), EAN (10) y Costo (15).
 * Calcula Margen y Ganancia.
 */
async function processProviderFile(filePath, vendor) {
    if (!fs.existsSync(filePath)) {
        console.error(`[ERROR] Archivo no encontrado: ${filePath}`);
        return;
    }

    console.log(`Iniciando procesamiento de catálogo para: ${vendor}...`);

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let batch = db.batch();
    let batchCount = 0;
    let totalCount = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;

        // Romper por comas respetando el texto dentro de comillas dobles
        const row = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.replace(/^"|"$/g, '').trim());

        if (row.length < 15) continue; // Ignorar líneas cortas / cabeceras truncadas

        // ==========================================
        // EXTRACCIÓN DE DATOS REQUERIDA (1-indexado, por tanto array-index = N-1)
        // ==========================================
        const sku = row[1]; // Segundo campo
        const pvpValue = parseFloat(row[6]) || 0; // Séptimo campo
        const ean = row[9]; // Décimo campo

        // Ingram stock tends to be at the third-to-last field (00000002 etc)
        const existenciaIndex = vendor === 'CT' ? 13 : (row.length - 3);
        const existencia = parseInt(row[existenciaIndex]) || 0;

        const costoValue = parseFloat(row[14]) || 0; // Décimo quinto campo

        let ganancia = 0;
        let margen = 0;

        // Cálculos financieros requeridos
        if (pvpValue > costoValue) {
            ganancia = pvpValue - costoValue;
            margen = ((pvpValue - costoValue) / pvpValue) * 100;
        }

        // ==========================================
        // ESTRATEGIA ZERO EGRESS COST (HOTLINKING)
        // ==========================================
        let imageUrl = '';
        if (vendor === 'CT') {
            imageUrl = `https://imagenes.ctonline.mx/promociones/${sku}.jpg`;
        } else {
            // Let the frontend compose the inquirecontent2 dynamic URL
            imageUrl = '';
        }

        const collectionName = vendor === 'CT' ? 'ct_catalog' : 'ingram_catalog';
        const docRef = db.collection(collectionName).doc(sku);

        // Upload a Firebase (BODEGA/PROVEEDOR)
        batch.set(docRef, {
            sku: sku,
            ean: ean,
            existencia: existencia, // Stock number for frontend
            retailPrice: pvpValue, // Solo visible para el Front

            // ==========================================
            // SEGURIDAD DE NEGOCIO (Filtrados por la Cloud Function)
            // ==========================================
            costoInterno: parseFloat(costoValue.toFixed(2)),
            gananciaBruta: parseFloat(ganancia.toFixed(2)),
            margenUtilidad: parseFloat(margen.toFixed(2)),

            imagenUrl: imageUrl,
            vendorName: vendor,
            source: vendor,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        batchCount++;
        totalCount++;

        if (batchCount === 450) {
            await batch.commit();
            console.log(`Guardados ${totalCount} productos...`);
            batch = db.batch();
            batchCount = 0;
        }
    }

    if (batchCount > 0) {
        await batch.commit();
    }

    console.log(`[ÉXITO] ${totalCount} productos de ${vendor} importados y evaluados.`);
}

module.exports = { processProviderFile };
