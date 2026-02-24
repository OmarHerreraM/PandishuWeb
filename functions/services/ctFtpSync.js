/**
 * Pandishú — CT Connect FTP Ingestion Service
 * 
 * Se conecta al FTP de CT Internacional para descargar inventarios
 * y catálogos en formato JSON y XML.
 */

const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');

const ftpConfig = {
    host: '216.70.82.104',
    user: 'DFP2631',
    password: 'hMlrhbEAvy0ungi3UxsvFkQtHmHtYyy5'
};

/**
 * Conecta al FTP de CT y descarga los archivos de Stock (JSON) y Catálogo Maestro (XML).
 * Prioridad: Stock Rápido cada 15 min, Catálogo XML 1 vez al día.
 * 
 * @param {string} localDir - Directorio local para guardar los archivos temporalmente
 */
async function syncCTCatalog(localDir) {
    const client = new ftp.Client();
    // client.ftp.verbose = true; // Activar para debug extremo

    try {
        console.log('🔄 Iniciando conexión FTP con CT Internacional...');
        await client.access(ftpConfig);

        console.log('📂 Listando directorio raíz de CT...');
        const list = await client.list();
        // console.log(list.map(f => f.name));

        // 1. Descarga del Stock Rápido (Prioridad 1)
        const jsonPath = path.join(localDir, 'ct_stock.json');
        try {
            // Asumiendo que existe un archivo con nombre estándar 'inventario.json'
            await client.downloadTo(jsonPath, 'inventario.json');
            console.log('✅ Stock rápido (JSON) sincronizado.');
        } catch (e) {
            console.log('⚠️ Archivo inventario.json no encontrado en la raíz. Omitiendo.');
        }

        // 2. Descarga del Catálogo Maestro Completo (Prioridad 2)
        const xmlPath = path.join(localDir, 'ct_catalog.xml');
        try {
            // Asumiendo que existe un archivo con nombre estándar 'catalogo.xml'
            await client.downloadTo(xmlPath, 'catalogo.xml');
            console.log('✅ Catálogo Maestro (XML) sincronizado.');
        } catch (e) {
            console.log('⚠️ Archivo catalogo.xml no encontrado en la raíz. Omitiendo.');
        }

        return { jsonPath, xmlPath };
    } catch (err) {
        console.error('❌ Error general conectando al FTP de CT:', err.message);
        throw err;
    } finally {
        client.close();
    }
}

module.exports = { syncCTCatalog };
