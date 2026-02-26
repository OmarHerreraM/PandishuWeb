const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const workbook = xlsx.readFile('./listado almacenes (002).xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];

const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

const warehouses = [];

// Skip header row
for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0]) continue; // Skip empty rows

    const almacenId = String(row[0]).trim();
    const name = String(row[1] || '').trim();
    const zipCode = String(row[7] || '').trim().padStart(5, '0'); // Ensure 5 digits
    const city = String(row[8] || '').trim();
    const state = String(row[9] || '').trim();

    warehouses.push({
        id: almacenId,
        name,
        zipCode,
        city,
        state
    });
}

// Write to functions/services/warehouses.json
const outputFilePath = path.join(__dirname, 'functions', 'services', 'warehouses.json');
fs.writeFileSync(outputFilePath, JSON.stringify(warehouses, null, 2));

console.log(`Successfully generated ${outputFilePath} with ${warehouses.length} warehouses.`);
