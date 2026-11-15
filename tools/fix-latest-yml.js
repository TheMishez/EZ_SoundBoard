// After the installer is code-signed its bytes change, so the sha512/size that
// electron-builder wrote into dist/latest.yml no longer match. This rewrites them
// (and drops the now-stale .blockmap; the updater then downloads the full file).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
const ymlPath = path.join(dist, 'latest.yml');
if (!fs.existsSync(ymlPath)) { console.log('no latest.yml, nothing to fix'); process.exit(0); }
let yml = fs.readFileSync(ymlPath, 'utf8');
const m = yml.match(/^path:\s*(.+)$/m);
if (!m) { console.error('latest.yml has no path'); process.exit(1); }
const exeName = m[1].trim().replace(/^['"]|['"]$/g, '');
const exe = path.join(dist, exeName);
const buf = fs.readFileSync(exe);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const before = (yml.match(/^\s*sha512:\s*(.+)$/m) || [])[1];
if (before && before.trim() === sha512) { console.log('latest.yml already matches', exeName); process.exit(0); }
yml = yml.replace(/^(\s*sha512:\s*).+$/gm, '$1' + sha512).replace(/^(\s*size:\s*)\d+$/gm, '$1' + buf.length);
fs.writeFileSync(ymlPath, yml);
const bm = exe + '.blockmap';
if (fs.existsSync(bm)) fs.unlinkSync(bm);
console.log('updated latest.yml for signed', exeName, buf.length, 'bytes');
