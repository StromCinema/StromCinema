// After packaging: add the mpv folder and the README next to Strom.exe
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, 'release', 'Strom-win32-x64');
fs.mkdirSync(path.join(out, 'mpv'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'extra-README.txt'), path.join(out, 'README.txt'));
fs.copyFileSync(path.join(__dirname, 'extra-PUT-MPV-HERE.txt'), path.join(out, 'mpv', 'PUT-MPV-HERE.txt'));
console.log('\nDone. Now copy mpv.exe into  ' + path.join(out, 'mpv') + '  and zip the folder  ' + out);
