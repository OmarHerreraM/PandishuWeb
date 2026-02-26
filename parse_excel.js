const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const workbook = xlsx.readFile('./listado almacenes (002).xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];

// Convert to JSON
const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

// The image showed headers might be missing or on row 1.
// Let's just dump the raw data to see its structure first.
fs.writeFileSync('warehouses_raw.json', JSON.stringify(data.slice(0, 5), null, 2));

console.log("Extracted first 5 rows to warehouses_raw.json");
