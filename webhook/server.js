const http = require('http');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');

const PORT = 9000;
const SECRET = process.env.WEBHOOK_SECRET || 'apex-deploy-secret';
const REPO_DIR = '/opt/apex-contracts';

function verify(body, sig) {
  if (!SECRET) return true;
  const hmac = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return sig === `sha256=${hmac}`;
}

function deploy() {
  console.log(`[${new Date().toISOString()}] Starting deploy...`);
  try {
    // Force the working tree to match origin/main rather than `git pull`.
    // A plain pull aborts whenever a tracked file has drifted on the server
    // (CRLF changes, a manual `sed`, etc.), which silently freezes deploys.
    // App data lives in gitignored bind-mounts (data/, chroma/), so a hard
    // reset never touches it.
    execSync(`cd ${REPO_DIR} && git fetch origin main && git reset --hard origin/main`, { stdio: 'inherit', timeout: 30000 });
    console.log('Synced working tree to origin/main.');
    exec(`cd ${REPO_DIR} && docker compose up -d --build apex-contracts`, (err, stdout, stderr) => {
      if (err) console.error('Build error:', stderr);
      else console.log('Rebuild complete:', stdout);
    });
  } catch (e) {
    console.error('Deploy failed:', e.message);
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const sig = req.headers['x-hub-signature-256'] || '';
      if (!verify(body, sig)) {
        console.log('Invalid signature');
        res.writeHead(403);
        return res.end('Forbidden');
      }
      try {
        const payload = JSON.parse(body);
        if (payload.ref === 'refs/heads/main') {
          console.log(`Push to main by ${payload.pusher?.name}`);
          res.writeHead(200);
          res.end('Deploying...');
          deploy();
        } else {
          res.writeHead(200);
          res.end('Ignored (not main)');
        }
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
    });
  } else {
    res.writeHead(200);
    res.end('Webhook listener OK');
  }
}).listen(PORT, () => console.log(`Webhook listener on :${PORT}`));
