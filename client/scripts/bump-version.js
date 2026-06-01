import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '../package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const parts = pkg.version.split('.').map(Number);
parts[2] += 1; // bump patch
pkg.version = parts.join('.');

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Version bumped to ${pkg.version}`);
