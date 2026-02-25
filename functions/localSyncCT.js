/**
 * localSyncCT.js — Ejecutar LOCALMENTE para poblar Firestore con el catálogo de CT
 * Usa las credenciales de Application Default de Firebase (ya autenticado con 'firebase login')
 */
require('dotenv').config();

const ftp = require('basic-ftp');
const admin = require('firebase-admin');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Inicializar Firebase Admin con las credenciales por defecto
admin.initializeApp({
    projectId: 'pandishu-web-1d860'
});

const MXN_RATE = parseFloat(process.env.MXN_EXCHANGE_RATE) || 17.50;

const ftpConfig = {
    host: '216.70.82.104',
    user: 'DFP2631',
    password: 'hMlrhbEAvy0ungi3UxsvFkQtHmHtYyy5'
};

async function runSync() {
    console.log('🔄 [LOCAL] Iniciando sync CT FTP → Firestore...');
    const client = new ftp.Client();
    client.ftp.verbose = false;
    const localPath = path.join(os.tmpdir(), `ct_stock_local.json`);

    try {
        await client.access(ftpConfig);
        console.log('✅ FTP conectado.');

        await client.cd('catalogo_xml');
        const list = await client.list();
        console.log('📂 Archivos en /catalogo_xml:');
        list.forEach(f => console.log(`   ${f.name} — ${(f.size / 1024).toFixed(1)} KB`));

        // Buscar JSON primero (stock en tiempo real), luego XML
        const jsonFile = list.find(f => f.name.toLowerCase().endsWith('.json'));
        const xmlFile = list.find(f => f.name.toLowerCase().endsWith('.xml'));

        const targetFile = jsonFile || xmlFile;
        if (!targetFile) {
            console.error('❌ No se encontró JSON ni XML en /catalogo_xml');
            client.close();
            return;
        }

        console.log(`\n📥 Descargando: ${targetFile.name} (${(targetFile.size / 1024).toFixed(1)} KB)`);
        await client.downloadTo(localPath, targetFile.name);
        client.close();
        console.log(`✅ Descargado en: ${localPath}`);

        // Parsear el archivo
        const raw = fs.readFileSync(localPath, 'utf-8');
        console.log(`\n📄 Primeros 300 caracteres del archivo:\n${raw.substring(0, 300)}\n`);

        let productArray = [];
        try {
            const parsed = JSON.parse(raw);
            productArray = Array.isArray(parsed) ? parsed : (parsed.productos || parsed.data || parsed.items || []);
        } catch (e) {
            console.error('❌ Error al parsear JSON:', e.message);
            return;
        }

        console.log(`📦 Total productos encontrados: ${productArray.length}`);
        if (productArray.length > 0) {
            console.log('📋 Muestra del primer producto:', JSON.stringify(productArray[0], null, 2));
        }

        // Mapear al formato unificado Pandishú
        const mapped = productArray.map(p => {
            let price = parseFloat(p.precio || p.price || 0);
            const currency = (p.moneda || p.currency || 'USD').toUpperCase();
            if (currency === 'USD') price = Math.round(price * MXN_RATE * 100) / 100;
            return {
                ingramPartNumber: String(p.codigo || p.clave || p.sku || ''),
                vendorName: p.marca || p.brand || 'CT Internacional',
                vendorPartNumber: p.numParte || '',
                description: p.nombre || p.descripcion || p.description || 'Sin descripción',
                productCategory: p.subcategoria || p.categoria || '',
                image: p.imagen || p.image || '',
                price: price,
                currency: 'MXN',
                availability: { availableQuantity: parseInt(p.existencia || p.stock || 0) },
                source: 'CT'
            };
        }).filter(p => p.ingramPartNumber);

        console.log(`\n✅ Productos válidos para guardar: ${mapped.length}`);

        // Escribir a Firestore en batches
        const db = admin.firestore();
        const BATCH_SIZE = 400;
        let written = 0;

        // Limpiar colección anterior
        console.log('\n🗑️ Limpiando colección ct_catalog anterior...');
        const existingDocs = await db.collection('ct_catalog').limit(1000).get();
        if (!existingDocs.empty) {
            const deleteBatch = db.batch();
            existingDocs.docs.forEach(d => deleteBatch.delete(d.ref));
            await deleteBatch.commit();
            console.log(`   Borrados ${existingDocs.size} documentos anteriores.`);
        }

        // Escribir nuevos
        for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
            const batch = db.batch();
            const chunk = mapped.slice(i, i + BATCH_SIZE);
            chunk.forEach(product => {
                const ref = db.collection('ct_catalog').doc(product.ingramPartNumber);
                batch.set(ref, { ...product, syncedAt: new Date().toISOString() });
            });
            await batch.commit();
            written += chunk.length;
            console.log(`   💾 ${written}/${mapped.length} productos escritos...`);
        }

        try { fs.unlinkSync(localPath); } catch (e) { }

        console.log(`\n🎉 ¡SYNC COMPLETADO! ${written} productos de CT ahora están en Firestore.`);
        process.exit(0);

    } catch (err) {
        client.close();
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

runSync();
