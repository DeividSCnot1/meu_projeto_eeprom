const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'data', 'crosser150.bin');
const original = fs.readFileSync(filePath);

console.log('Tamanho do arquivo:', original.length, 'bytes');
