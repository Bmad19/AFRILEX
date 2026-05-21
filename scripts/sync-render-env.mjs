#!/usr/bin/env node
/**
 * Génère render-env-local.txt (gitignored) — à coller une fois dans Render → Environment
 * si le déploiement auto ne suffit pas pour les secrets.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq === -1) return;
    o[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  });
  return o;
}

const local = loadEnv(path.join(root, '.env.local'));
const encFile = path.join(root, 'secrets', 'mailbox-encryption.key');
const encKey = fs.existsSync(encFile) ? fs.readFileSync(encFile, 'utf8').trim() : '';

const lines = [
  '# Coller chaque ligne dans Render → afrilex-api → Environment (une variable par ligne)',
  '',
  `SUPABASE_URL=${local.SUPABASE_URL || ''}`,
  `SUPABASE_SERVICE_ROLE_KEY=${local.SUPABASE_SERVICE_ROLE_KEY || ''}`,
  `GROQ_API_KEY=${local.GROQ_API_KEY || ''}`,
  'CORS_ORIGINS=https://www.afrilexconseil.com,https://afrilexconseil.com',
  `MAILBOX_ENCRYPTION_KEY=${encKey}`,
  '',
];

const out = path.join(root, 'render-env-local.txt');
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`✅ ${out} généré (ne pas committer).`);
