import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await copyFile('node_modules/bulma/css/bulma.min.css', 'public/vendor/bulma.min.css');
console.log('Bulma 1 stylesheet ready.');
