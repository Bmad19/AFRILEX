#!/usr/bin/env node
/**
 * Prépare l'envoi mail LWS dans dist/ (Supabase + déchiffrement via Render + SMTP local).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq === -1) return;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  });
  return out;
}

function phpQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const local = loadEnvFile(path.join(root, '.env.local'));
const prod = loadEnvFile(path.join(root, '.env.production'));

const SUPABASE_URL = local.SUPABASE_URL || prod.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = local.SUPABASE_SERVICE_ROLE_KEY || prod.SUPABASE_SERVICE_ROLE_KEY || '';
const BUREAU_API_URL = local.VITE_BUREAU_API || prod.VITE_BUREAU_API || 'https://afrilex.onrender.com/api/bureau';

const encKeyFile = path.join(root, 'secrets', 'mailbox-encryption.key');
let MAILBOX_ENCRYPTION_KEY = local.MAILBOX_ENCRYPTION_KEY || prod.MAILBOX_ENCRYPTION_KEY || '';
if (!MAILBOX_ENCRYPTION_KEY && fs.existsSync(encKeyFile)) {
  MAILBOX_ENCRYPTION_KEY = fs.readFileSync(encKeyFile, 'utf8').trim();
}
if (!MAILBOX_ENCRYPTION_KEY) {
  MAILBOX_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(encKeyFile, MAILBOX_ENCRYPTION_KEY + '\n', 'utf8');
}

function readExistingProxySecret() {
  for (const p of [
    path.join(root, 'secrets', 'mailbox-relay.config.php'),
    path.join(root, 'public', 'api', 'mailbox-relay.config.php'),
  ]) {
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/MAILBOX_PROXY_SECRET['"],\s*['"]([a-f0-9]{48,64})['"]/i);
    if (m) return m[1];
  }
  return null;
}

const proxySecret = readExistingProxySecret() || crypto.randomBytes(32).toString('hex');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents — vérifiez .env.local avant npm run build.');
}

const php = `<?php
// Généré par scripts/setup-mailbox-relay.mjs — ne pas éditer à la main.
if (!defined('SUPABASE_URL')) {
    define('SUPABASE_URL', '${phpQuote(SUPABASE_URL)}');
}
if (!defined('SUPABASE_SERVICE_ROLE_KEY')) {
    define('SUPABASE_SERVICE_ROLE_KEY', '${phpQuote(SUPABASE_SERVICE_ROLE_KEY)}');
}
if (!defined('MAILBOX_ENCRYPTION_KEY')) {
    define('MAILBOX_ENCRYPTION_KEY', '${phpQuote(MAILBOX_ENCRYPTION_KEY)}');
}
if (!defined('BUREAU_API_URL')) {
    define('BUREAU_API_URL', '${phpQuote(BUREAU_API_URL)}');
}
if (!defined('MAILBOX_PROXY_SECRET')) {
    define('MAILBOX_PROXY_SECRET', '${proxySecret}');
}
`;

const publicApi = path.join(root, 'public', 'api');
const publicBureau = path.join(publicApi, 'bureau');
fs.mkdirSync(publicBureau, { recursive: true });

for (const p of [
  path.join(root, 'secrets', 'mailbox-relay.config.php'),
  path.join(publicApi, 'mailbox-relay.config.php'),
  path.join(root, 'api', 'mailbox-relay.config.php'),
]) {
  fs.writeFileSync(p, php, 'utf8');
}

fs.copyFileSync(path.join(root, 'api', 'bureau', 'mailbox-send.php'), path.join(publicBureau, 'mailbox-send.php'));
fs.copyFileSync(path.join(root, 'api', 'bureau', 'mailbox-lib.php'), path.join(publicBureau, 'mailbox-lib.php'));
const bureauHtaccess = path.join(root, 'api', 'bureau', '.htaccess');
if (fs.existsSync(bureauHtaccess)) {
  fs.copyFileSync(bureauHtaccess, path.join(publicBureau, '.htaccess'));
}

fs.writeFileSync(
  path.join(publicApi, '.htaccess'),
  `<IfModule mod_rewrite.c>
RewriteEngine Off
</IfModule>
<Files "mailbox-relay.config.php">
  <IfModule mod_authz_core.c>
    Require all denied
  </IfModule>
</Files>
`,
  'utf8',
);

fs.writeFileSync(
  path.join(root, '.env.mailbox-relay.local'),
  `# Optionnel sur Render (même valeur que secrets/mailbox-encryption.key) :
MAILBOX_ENCRYPTION_KEY=${MAILBOX_ENCRYPTION_KEY}
`,
  'utf8',
);

console.log('✅ Envoi mail LWS prêt');
console.log(`   Déchiffrement mot de passe : via ${BUREAU_API_URL} (Render)`);
console.log(`   SMTP : serveur LWS (mail du domaine)`);
console.log('   → Uploadez tout dist/ sur public_html');
console.log('   → Redéployez une fois l’API Render (nouvel endpoint mail_password)');
