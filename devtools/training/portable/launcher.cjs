const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'training-data');
process.env.TRAINING_DATA_DIR = DATA;
const tokenPath = path.join(DATA, 'access-token');

fs.mkdirSync(DATA, { recursive: true });
let token;
if (fs.existsSync(tokenPath)) {
  token = fs.readFileSync(tokenPath, 'utf8').trim();
} else {
  token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
}

fs.writeFileSync(path.join(ROOT, 'client', 'config.json'), JSON.stringify({
  url: `http://127.0.0.1:${process.env.TRAINING_PORT || 4765}`,
  token,
}, null, 2) + '\n', 'utf8');
console.log('客户端连接配置已写入 client/config.json。');

require('./devtools/training/server/training-server.cjs');
