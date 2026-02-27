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

        // Buscamos archivos CSV o TXT o ZIP
        const targetFile = list.find(f => f.name.toLowerCase().includes('price') || f.name.toLowerCase().includes('catalog') || f.name.toLowerCase().endsWith('.zip') || f.size > 100000);

        if (targetFile) {
            console.log(`📥 Descargando archivo: ${targetFile.name} (${(targetFile.size / 1024 / 1024).toFixed(2)} MB)`);
            const ext = path.extname(targetFile.name).toLowerCase();
            let dlPath = localPath;
            if (ext === '.zip' && !localPath.endsWith('.zip')) {
                dlPath = localPath + '.zip';
            }
            await sftp.get(targetFile.name, dlPath);
            console.log('✅ Descarga SFTP completada.');

            if (dlPath.endsWith('.zip')) {
                console.log('📦 Descomprimiendo archivo ZIP...');
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(dlPath);
                zip.extractAllTo(path.dirname(localPath), true);
                const entries = zip.getEntries();
                if (entries.length > 0) {
                    const csvFile = entries.find(e => e.entryName.toLowerCase().endsWith('.csv') || e.entryName.toLowerCase().endsWith('.txt'));
                    if (csvFile) {
                        const extractedPath = path.join(path.dirname(localPath), csvFile.entryName);
                        // Rename standard csv name to target localPath
                        fs.renameSync(extractedPath, localPath);
                        console.log('✅ Extracción completada:', localPath);
                        return localPath;
                    }
                }
            }
            return dlPath;
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
