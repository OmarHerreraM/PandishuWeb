/**
 * Pandishú — Ingram Micro SFTP Ingestion Service
 * 
 * Este script automatiza la descarga de los archivos de catálogo de Ingram Micro
 * y los prepara para su normalización en el catálogo unificado de Pandishú.
 */

const Client = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
const sftp = new Client();

const config = {
    host: 'mercury.ingrammicro.com',
    port: 22,
    username: 'JH679K',
    password: 'uW%9d!c3Z4'
};

/**
 * Descarga el catálogo más reciente de Ingram.
 * @param {string} remotePath - Ruta en el servidor de Ingram (ej: './full_catalog.csv')
 * @param {string} localPath - Donde guardar el archivo temporalmente
 */
async function syncIngramCatalog(remotePath, localPath) {
    try {
        console.log('🔄 Iniciando conexión SFTP con Ingram Micro...');
        await sftp.connect(config);

        console.log('📂 Listando archivos remotos...');
        const list = await sftp.list('.');

        // Buscamos archivos CSV o TXT que contengan 'catalog' o tengan tamaño considerable
        const targetFile = list.find(f => f.name.toLowerCase().includes('catalog') || f.size > 1000000);

        if (targetFile) {
            console.log(`📥 Descargando archivo: ${targetFile.name} (${(targetFile.size / 1024 / 1024).toFixed(2)} MB)`);
            await sftp.get(targetFile.name, localPath);
            console.log('✅ Descarga completada.');
            return localPath;
        } else {
            console.warn('⚠️ No se encontró un archivo de catálogo claro. Revisa la lista:', list.map(l => l.name));
            return null;
        }
    } catch (err) {
        console.error('❌ Error en Sync Ingram SFTP:', err.message);
        throw err;
    } finally {
        await sftp.end();
    }
}

/**
 * Ejemplo de uso local (prueba)
 */
/*
const LOCAL_TEMP = path.join(__dirname, 'temp_ingram_catalog.csv');
syncIngramCatalog('.', LOCAL_TEMP)
    .then(path => {
        if (path) console.log('Procesar archivo en:', path);
    })
    .catch(console.error);
*/

module.exports = { syncIngramCatalog };
