'use strict';

const fs = require('node:fs');
const path = require('node:path');

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const roots = ['api'];
const files = roots.flatMap((root) => walk(path.join(process.cwd(), root)));

for (const file of files) {
  require(file);
}

console.log(`Loaded ${files.length} JavaScript files.`);
