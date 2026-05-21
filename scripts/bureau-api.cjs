// ══════════════════════════════════════════════════════════════════════════════
// Afrilex Conseil — API Express + Supabase (PostgreSQL)
// Lancer : node scripts/bureau-api.cjs  |  npm run dev:api
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const fs   = require('fs');

// ── Chargement .env.local ─────────────────────────────────────────────────────
const envFile = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  });
}

// ── Dépendances ───────────────────────────────────────────────────────────────
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { createClient } = require('@supabase/supabase-js');
let ImapFlow;
try { ({ ImapFlow } = require('imapflow')); } catch { ImapFlow = null; }
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
let simpleParser;
try { ({ simpleParser } = require('mailparser')); } catch { simpleParser = null; }
let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch { PDFDocument = null; }

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL  || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('\n❌  SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.');
  console.error('   → Renseignez-les dans .env.local puis relancez.\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db:   { schema: 'public' },
});

// ── WhatsApp Meta Cloud API ───────────────────────────────────────────────────
const WA_PHONE          = process.env.WA_PHONE          || '22656191930';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_PHONE_ID     = process.env.META_PHONE_ID     || '';

async function sendWhatsApp(message) {
  if (META_ACCESS_TOKEN && META_PHONE_ID) {
    try {
      const r = await fetch(`https://graph.facebook.com/v20.0/${META_PHONE_ID}/messages`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messaging_product: 'whatsapp', to: `+${WA_PHONE}`, type: 'text', text: { body: message } }),
      });
      const d = await r.json();
      if (r.ok) { console.log('📱 WhatsApp ✅'); return; }
      console.log('📱 WhatsApp erreur :', d?.error?.message);
    } catch (e) { console.log('📱 WhatsApp réseau :', e.message); }
  } else {
    console.log(`\n📱 ── WhatsApp (dev) ──────────────────────────────`);
    console.log(message);
    console.log(`🔗 wa.me/+${WA_PHONE}?text=${encodeURIComponent(message)}`);
    console.log(`──────────────────────────────────────────────────\n`);
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

const ALLOWED_ORIGINS = [
  'https://numafriq.com',
  'https://www.numafriq.com',
  'https://afrilexconseil.com',
  'https://www.afrilexconseil.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3100',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3100',
  'http://127.0.0.1:5173',
];
/** Tout origine http(s)://localhost:port — pratique dev (Vite peut changer de port si le port demandé est pris). */
const LOCALHOST_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/;
/** Par défaut autorise localhost:any port ; désactivez avec AFRILEX_RELAX_LOCAL_CORS=0 en prod stricte */
const RELAX_LOCALHOST_CORS = process.env.AFRILEX_RELAX_LOCAL_CORS !== '0';
/** Sites vitrine et sous-domaines (évite Failed to fetch si www vs apex déjà OK mais autre sous-domaine). */
const DEFAULT_SITE_ORIGIN =
  /^https?:\/\/([a-z0-9-]+\.)*(afrilexconseil\.com|numafriq\.com)(:\d+)?$/i;

function corsRegexList() {
  const raw = process.env.CORS_ORIGIN_PATTERNS || '';
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
const CORS_REGEXES = corsRegexList();

const EXTRA_CORS = (process.env.CORS_ORIGINS || '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || EXTRA_CORS.includes(origin)) return cb(null, true);
    if (RELAX_LOCALHOST_CORS && LOCALHOST_DEV_ORIGIN.test(origin)) return cb(null, true);
    if (DEFAULT_SITE_ORIGIN.test(origin)) return cb(null, true);
    if (CORS_REGEXES.some((re) => re.test(origin))) return cb(null, true);
    console.warn('[cors] origine refusée (CORS_ORIGINS ou CORS_ORIGIN_PATTERNS sur Render) :', origin);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' })); // 10mb pour autoriser les images base64 (couvertures blog)

const uploadCareersCv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5242880 },
});

// No-cache sur toutes les réponses API
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0',
  });
  next();
});

// Diagnostic : ouvrir GET http://localhost:3100/api/bureau/health (via proxy Vite) ou http://localhost:8080/api/bureau/health
app.get('/api/bureau/health', async (_req, res) => {
  try {
    const { error: uErr } = await supabase.from('users').select('id').limit(1);
    const { error: sErr } = await supabase.from('sessions').select('id').limit(1);
    const issues = [];
    if (uErr) issues.push(`users: ${uErr.message}`);
    if (sErr) issues.push(`sessions: ${sErr.message}`);
    if (issues.length) return res.status(503).json({ ok: false, issues });
    const proxyUrl = (process.env.MAILBOX_LWS_PROXY_URL || '').trim();
    let proxyPing = null;
    if (proxyUrl) {
      try {
        const pingUrl = proxyUrl.includes('?') ? `${proxyUrl}&ping=1` : `${proxyUrl}?ping=1`;
        const pr = await fetch(pingUrl, { signal: AbortSignal.timeout(15000) });
        const pt = await pr.text();
        proxyPing = { status: pr.status, ok: pr.ok, body: pt.slice(0, 200) };
      } catch (e) {
        proxyPing = { ok: false, error: String(e?.message || e) };
      }
    }
    return res.json({
      ok: true,
      mailbox_proxy: mailboxProxyConfigured(),
      mailbox_proxy_url: proxyUrl || null,
      mailbox_proxy_ping: proxyPing,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Diagnostic complet du schéma : signale quels addons SQL sont à exécuter.
 * Aucune authentification requise (mais aucune donnée sensible exposée, juste des présence/absence).
 * À utiliser depuis l'UI de paramètres système ou en debug.
 */
app.get('/api/bureau/schema-check', async (_req, res) => {
  const expected = [
    { table: 'users',                addon: 'sql/supabase-setup.sql',           module: 'Authentification (CORE)' },
    { table: 'projects',             addon: 'sql/supabase-setup.sql',           module: 'Projets (CORE)' },
    { table: 'clients',              addon: 'sql/supabase-setup.sql',           module: 'Clients (CORE)' },
    { table: 'mailbox_accounts',     addon: 'sql/supabase_perms_mailbox_addon.sql', module: 'Boîte mail LWS' },
    { table: 'job_offers',           addon: 'sql/supabase_blog_jobs_addon.sql', module: 'Offres d\'emploi + Blog' },
    { table: 'job_applications',     addon: 'sql/supabase_inbox_addon.sql',     module: 'Candidatures (Inbox)' },
    { table: 'case_milestones',      addon: 'sql/supabase_cases_addon.sql',     module: 'Dossiers — étapes / documents' },
    { table: 'case_events',          addon: 'sql/supabase_cases_addon.sql',     module: 'Calendrier' },
    { table: 'case_documents',       addon: 'sql/supabase_cases_addon.sql',     module: 'Dossiers — documents' },
    { table: 'case_clients',         addon: 'sql/supabase_cases_addon.sql',     module: 'Dossiers — clients liés' },
    { table: 'case_invoices',        addon: 'sql/supabase_phase2_addon.sql',    module: 'Tableau financier — factures' },
    { table: 'case_payments',        addon: 'sql/supabase_phase2_addon.sql',    module: 'Tableau financier — paiements' },
    { table: 'case_event_requests',  addon: 'sql/supabase_phase2_addon.sql',    module: 'Demandes RDV client' },
    { table: 'case_activities',      addon: 'sql/supabase_phase2_addon.sql',    module: 'Diligences (time-tracking)' },
    { table: 'case_signatures',      addon: 'sql/supabase_phase3_addon.sql',    module: 'Signatures électroniques' },
    { table: 'case_templates',       addon: 'sql/supabase_phase3_addon.sql',    module: 'Modèles de dossier' },
  ];
  const checks = await Promise.all(expected.map(async (e) => {
    const { error } = await supabase.from(e.table).select('*', { count: 'exact', head: true });
    return { ...e, present: !error };
  }));
  const missing_addons = Array.from(new Set(checks.filter((c) => !c.present).map((c) => c.addon)));
  return res.json({
    ok: missing_addons.length === 0,
    checks,
    missing_addons,
    message: missing_addons.length === 0
      ? 'Toutes les tables sont présentes. Schéma à jour.'
      : `Schéma incomplet. Exécutez les scripts SQL suivants dans Supabase SQL Editor : ${missing_addons.join(', ')}.`,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const makeToken  = () => crypto.randomBytes(32).toString('hex');
const in8h       = () => new Date(Date.now() + 8  * 3600_000).toISOString();
const in12h      = () => new Date(Date.now() + 12 * 3600_000).toISOString();
const now        = () => new Date().toISOString();
const ROLES      = { agent: 1, admin: 2, super_admin: 3 };

/** Évite une exception bcryptjs (« Illegal arguments ») si hash absent ou invalide — sinon erreur HTTP 500 au login. */
function safeComparePassword(plain, hash) {
  if (plain == null || hash == null || typeof hash !== 'string' || hash.length < 20) return false;
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch {
    return false;
  }
}

/** Token bureau : header Authorization, query bureau_token ou corps JSON (appels PHP LWS → Render). */
function getBearerToken(req) {
  const m = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = req.query?.bureau_token;
  if (q) return String(q).trim();
  const b = req.body?.bureau_token;
  if (b) return String(b).trim();
  return null;
}

// Auth guard bureau — retourne user ou null (envoie la réponse si erreur)
async function authGuard(req, res, minRole = 'agent') {
  const token = getBearerToken(req);
  if (!token) { res.status(401).json({ error: 'Non authentifié' }); return null; }

  // Essai 1 : avec la colonne `permissions` (addon supabase_perms_mailbox_addon.sql appliqué)
  let { data: sess, error: sessErr } = await supabase
    .from('sessions')
    .select('expires_at, user:users!user_id(id,username,full_name,email,role,active,first_login,avatar,password,permissions)')
    .eq('token', token)
    .maybeSingle();
  // Fallback : colonne `permissions` absente → on retry sans elle (schéma de base)
  if (sessErr && /permissions|does not exist|schema cache/i.test(sessErr.message || '')) {
    const fb = await supabase
      .from('sessions')
      .select('expires_at, user:users!user_id(id,username,full_name,email,role,active,first_login,avatar,password)')
      .eq('token', token)
      .maybeSingle();
    sess = fb.data; sessErr = fb.error;
  }

  if (sessErr || !sess || new Date(sess.expires_at) < new Date() || !sess.user?.active) {
    res.status(401).json({ error: 'Session expirée' });
    return null;
  }
  if ((ROLES[sess.user.role] ?? 0) < (ROLES[minRole] ?? 0)) {
    res.status(403).json({ error: 'Accès refusé' });
    return null;
  }
  // Prolonge la session
  await supabase.from('sessions').update({ expires_at: in8h() }).eq('token', token);
  req.user = sess.user;
  return sess.user;
}

/** Liste des modules permission-aware (synchronisé avec la sidebar). super_admin a toujours tout. */
const PERMISSION_KEYS = [
  'leads', 'assistant', 'projects', 'missions', 'clients', 'chat',
  'hr', 'accounting', 'feedback', 'job_offers', 'blog',
  'mailbox',
];
function userHasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const raw = String(user.permissions ?? '').trim();
  if (!raw || raw === '*') return true;
  const set = new Set(raw.split(/[,;\s]+/).filter(Boolean));
  if (set.has('*')) return true;
  return set.has(perm);
}
/** Garde permission après authGuard. Renvoie 403 si l'utilisateur n'a pas la perm demandée. */
function permGuard(req, res, perm) {
  if (userHasPermission(req.user, perm)) return true;
  res.status(403).json({ error: `Module « ${perm} » non autorisé pour ce compte.` });
  return false;
}

/** Normalise une CSV de permissions (whitelist + dédoublonnage + tri). */
function normalizePermissions(input) {
  if (input == null) return null;
  const str = Array.isArray(input) ? input.join(',') : String(input);
  const trimmed = str.trim();
  if (!trimmed || trimmed === '*') return null;
  const allowed = new Set(PERMISSION_KEYS);
  const list = Array.from(
    new Set(
      trimmed
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && allowed.has(s))
    )
  ).sort();
  return list.length ? list.join(',') : null;
}

// Auth guard client
async function clientGuard(req, res) {
  const m = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Non authentifié' }); return null; }

  const { data: sess } = await supabase
    .from('client_sessions')
    .select('expires_at, client:clients!client_id(id,name,email,company,phone,project_id,active,password)')
    .eq('token', m[1])
    .single();

  if (!sess || new Date(sess.expires_at) < new Date() || !sess.client?.active) {
    res.status(401).json({ error: 'Non authentifié' }); return null;
  }
  req.client = sess.client;
  return sess.client;
}

// Auth guard agent depuis route client (même token bureau)
async function agentTokenGuard(req, res) {
  const m = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'Non authentifié' }); return null; }

  const { data: sess } = await supabase
    .from('sessions')
    .select('expires_at, user:users!user_id(id,role,active,permissions)')
    .eq('token', m[1])
    .gt('expires_at', now())
    .single();

  if (!sess || !sess.user?.active) { res.status(401).json({ error: 'Non authentifié' }); return null; }
  req.user = sess.user;
  return sess.user;
}



/** Aligné avec api/contact.php — domain pour assignation pôle métier */
function resolveLeadDomain(service) {
  const s = String(service ?? '').trim().toLowerCase();
  const dm = {
    'non précisé':       'non_classe',
    'non precisé':       'non_classe',
    'conseil-juridique': 'juridique',
    fiscalite:           'fiscal',
    fiscalité:           'fiscal',
    comptabilite:        'comptabilite',
    comptabilité:        'comptabilite',
    structuration:       'structuration',
    investissement:      'investissement',
    autre:               'autre',
  };
  return dm[s] || 'non_classe';
}

function walkKbMarkdownFiles(absDir, relBase, collected) {
  if (!fs.existsSync(absDir)) return;
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(absDir, ent.name);
    const rel = path.join(relBase, ent.name).replace(/\\/g, '/');
    if (ent.isDirectory()) walkKbMarkdownFiles(abs, rel, collected);
    else if (ent.name.endsWith('.md')) {
      try {
        collected.push({ rel, body: fs.readFileSync(abs, 'utf8') });
      } catch {
        /* ignore fichiers illisibles */
      }
    }
  }
}

function loadKbBureauMarkdown(maxLen = 32000) {
  const kbDir = path.join(__dirname, '..', 'api', 'bureau', 'kb');
  const chunks = [];
  walkKbMarkdownFiles(kbDir, '', chunks);
  chunks.sort((a, b) => a.rel.localeCompare(b.rel));
  let buf = '';
  for (const { rel, body } of chunks) {
    buf += `\n\n<!-- ${rel || 'racine'} -->\n${body}`;
    if (buf.length > maxLen) break;
  }
  return buf.length > maxLen ? buf.slice(0, maxLen) + '\n\n… [tronqué pour limite tokens]' : buf;
}

/** memo_litige → même pipeline que mémoire de défense (synonyme métier). */
function normalizeAssistantMode(mode) {
  const m = String(mode ?? 'assist').trim().toLowerCase();
  if (m === 'memo_litige') return 'memo_defense';
  return m === 'memo_defense' ? 'memo_defense' : 'assist';
}

const ASSISTANT_MAX_MSG_CHARS = 12000;
function sanitizeAssistantMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(-20)) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let content = typeof item.content === 'string' ? item.content.replace(/\u0000/g, '').trim() : '';
    if (content.length > ASSISTANT_MAX_MSG_CHARS) {
      content = content.slice(0, ASSISTANT_MAX_MSG_CHARS) + '\n… [message tronqué]';
    }
    if (!content) continue;
    out.push({ role, content });
  }
  return out.slice(-14);
}

function userHandlesLeadDomain(practiceCsv, leadDomain) {
  const ld = String(leadDomain || '').trim().toLowerCase();
  if (!ld || ld === 'non_classe') return true;
  const csv = String(practiceCsv || '').trim().toLowerCase();
  if (!csv) return true;
  const parts = csv.split(/[,;/|]/).map((s) => s.trim()).filter(Boolean);
  return parts.some((p) => p === '*' || p === 'tous' || p === ld);
}

/** Premier agent dont les pôles couvrent le domaine du lead (sinon null). */
async function pickAssigneeUserIdForDomain(domain) {
  try {
    const d = String(domain ?? '').trim().toLowerCase();
    if (!d || d === 'non_classe') return null;
    const { data, error } = await supabase
      .from('users')
      .select('id, practice_domains')
      .eq('active', true)
      .in('role', ['agent', 'admin']);
    if (error) return null;
    const cand = (data ?? []).filter((u) => userHandlesLeadDomain(u.practice_domains, d));
    return cand[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Hash bcrypt pré-calculé — mot de passe : AfrilexBureau2026! (compte secours « afrilex_agent », changer en production). */
const BOOTSTRAP_AFRILEX_AGENT_HASH =
  '$2b$12$10Pkk3gCJOHWmt8mKnJjuuuCEOvSEJL7J/pwGKNCtMndn5X68NRMG';

/** Hash bcrypt : mot de passe initial « SAGNON » (majuscules). Rotation obligatoire en production. */
const BOOTSTRAP_SAGNON_HASH =
  '$2b$12$neroZBVpVUyy9dg0Wvnaau7jpfjn/IViI9p6EO8xKZ.Tatfqyp8pS';

/** Base vide uniquement — crée données démo cabinet + administrateur système prévu hors documentation publique du secret. */
async function seedCabinetDemoIfTotallyEmpty() {
  const { count: uc } = await supabase.from('users').select('*', { count: 'exact', head: true });
  if (uc > 0) return;

  await supabase.from('users').insert({
    username: 'sagnon',
    password: BOOTSTRAP_SAGNON_HASH,
    full_name: 'Administrateur Afrilex',
    email: 'cabinet@afrilexconseil.com',
    role: 'super_admin',
    first_login: false,
    active: true,
    practice_domains: null,
  });
  const { data: admin } = await supabase.from('users').select('id').eq('username', 'sagnon').single();
  const aid = admin?.id ?? 1;

  const { data: p1 } = await supabase
    .from('projects')
    .insert({
      name: 'Révision groupement consortium',
      client: 'Client confidentiel',
      description: 'Structuration projet et défense pré-contentieuse.',
      status: 'en_cours',
      priority: 'haute',
      budget: 0,
      progress: 40,
      created_by: aid,
    })
    .select().single();

  await supabase.from('projects').insert([
    {
      name: 'Contentieux créance commerciale',
      client: 'Client confidentiel',
      description: 'Préparation pièces sous cadre OHADA — synthèses internes.',
      status: 'en_cours',
      priority: 'normale',
      budget: 0,
      progress: 25,
      created_by: aid,
    },
  ]);

  await supabase.from('accounting').insert([
    {
      type: 'recette',
      category: 'Honoraires',
      amount: 0,
      description: 'À personnaliser (exemple démo vide)',
      date: '2026-01-15',
      created_by: aid,
      project_id: p1?.id ?? null,
    },
  ]);

  console.log(
    '\n✅ Base Supabase initialisée (cabinet) : compte super_admin « sagnon » — mot de passe initial : SAGNON (à changer tout de suite en production).\n'
  );
}

async function ensureBootstrapAdminExists() {
  const { data: row } = await supabase.from('users').select('id').eq('username', 'sagnon').maybeSingle();
  if (row?.id) {
    if (process.env.AFRILEX_LOCAL_SYNC_SAGNON === '1') {
      await supabase
        .from('users')
        .update({ password: BOOTSTRAP_SAGNON_HASH, active: true, first_login: false })
        .eq('id', row.id);
      console.log('🔧 AFRILEX_LOCAL_SYNC_SAGNON=1 — hash mot de passe « sagnon » réaligné sur le bootstrap (SAGNON). Retirez la variable après la première connexion réussie.');
    }
    return;
  }
  await supabase.from('users').insert({
    username: 'sagnon',
    password: BOOTSTRAP_SAGNON_HASH,
    full_name: 'Administrateur Afrilex',
    email: 'cabinet@afrilexconseil.com',
    role: 'super_admin',
    first_login: false,
    active: true,
    practice_domains: null,
  });
  console.log('✅ Compte « sagnon » ajouté — identifiant : sagnon ou SAGNON ; mot de passe initial : SAGNON');
}

/** Compte bureau de secours (identifiant afrilex_agent) — créé si absent ; mot de passe réaligné si AFRILEX_SYNC_AGENT_LOGIN=1 */
async function ensureAfrilexAgentBootstrapUser() {
  const username = 'afrilex_agent';
  const { data: row } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  const payload = {
    username,
    password: BOOTSTRAP_AFRILEX_AGENT_HASH,
    full_name: 'Agent bureau Afrilex',
    email: 'agent@afrilexconseil.com',
    role: 'super_admin',
    first_login: false,
    active: true,
    practice_domains: null,
  };
  if (!row?.id) {
    const { error } = await supabase.from('users').insert(payload);
    if (error) {
      console.error('ensureAfrilexAgentBootstrapUser insert:', error);
      return;
    }
    console.log('✅ Compte secours « afrilex_agent » créé — mot de passe : AfrilexBureau2026! (à changer en production)');
    return;
  }
  if (process.env.AFRILEX_SYNC_AGENT_LOGIN === '1') {
    await supabase
      .from('users')
      .update({ password: BOOTSTRAP_AFRILEX_AGENT_HASH, active: true, first_login: false })
      .eq('id', row.id);
    console.log('🔧 AFRILEX_SYNC_AGENT_LOGIN=1 — mot de passe « afrilex_agent » réinitialisé sur le hash bootstrap.');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH BUREAU — aligné route + méthode HTTP (login POST, me GET, profile PUT)
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/auth.php', async (req, res) => {
  try {
    const { action } = req.query;
    const method = req.method;

  // ── Login ──────────────────────────────────────────────────────────────────
  if (method === 'POST' && action === 'login') {
    try {
      const rawUser = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const password = req.body?.password != null ? String(req.body.password) : '';
      const uname = rawUser.toLowerCase();
      if (!rawUser || !password)
        return res.status(400).json({ error: 'Identifiants requis' });

      const { data: user, error: selErr } = await supabase
        .from('users')
        .select('*')
        .eq('username', uname)
        .eq('active', true)
        .maybeSingle();

      if (selErr) {
        console.error('auth login select:', selErr);
        return res.status(500).json({ error: 'Erreur serveur (utilisateur)', detail: selErr.message });
      }

      if (!user || !safeComparePassword(password, user.password))
        return res.status(401).json({ error: 'Identifiants incorrects' });

      const token = makeToken();
      const { error: insErr } = await supabase.from('sessions').insert({
        user_id: user.id,
        token,
        expires_at: in8h(),
      });
      if (insErr) {
        console.error('auth login session:', insErr);
        return res.status(500).json({
          error: 'Impossible de créer la session',
          detail: insErr.message || String(insErr),
          hint: 'Vérifiez la table sessions (sql) et les clés étrangères user_id → users.id.',
        });
      }

      await supabase.from('users').update({ last_login: now() }).eq('id', user.id);

      return res.json({
        token,
        first_login: !!user.first_login,
        user: {
          id: Number(user.id),
          username: user.username,
          full_name: user.full_name,
          email: user.email,
          role: user.role,
          avatar: user.avatar ?? null,
          permissions: user.permissions ?? null,
        },
      });
    } catch (e) {
      console.error('auth login:', e);
      return res.status(500).json({ error: 'Erreur serveur', detail: String(e?.message || e) });
    }
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  if (method === 'POST' && action === 'logout') {
    const m = (req.headers.authorization ?? '').match(/Bearer\s+(.+)/i);
    if (m) await supabase.from('sessions').delete().eq('token', m[1]);
    return res.json({ success: true });
  }

  // ── Me ─────────────────────────────────────────────────────────────────────
  if (method === 'GET' && action === 'me') {
    const u = await authGuard(req, res); if (!u) return;
    return res.json({
      id: Number(u.id),
      username: u.username,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      avatar: u.avatar,
      first_login: !!u.first_login,
      permissions: u.permissions ?? null,
    });
  }

  // ── Change password ────────────────────────────────────────────────────────
  if (method === 'POST' && action === 'change_password') {
    const u = await authGuard(req, res); if (!u) return;
      const { new_password, old_password } = req.body;
      if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6)' });
      if (!u.first_login && !safeComparePassword(old_password ?? '', u.password))
        return res.status(401).json({ error: 'Ancien mot de passe incorrect' });
      await supabase.from('users').update({ password: bcrypt.hashSync(new_password, 12), first_login: false }).eq('id', u.id);
      return res.json({ success: true });
    }

  // ── Update profile ─────────────────────────────────────────────────────────
  if (method === 'PUT' && action === 'profile') {
    const u = await authGuard(req, res); if (!u) return;
      const { username, full_name, email } = req.body;
      const { data: dup } = await supabase.from('users').select('id').eq('username', username).neq('id', u.id).maybeSingle();
      if (dup) return res.status(409).json({ error: "Nom d'utilisateur déjà pris" });
      await supabase.from('users').update({ username, full_name, email }).eq('id', u.id);
      return res.json({ success: true });
    }

  return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('POST /api/bureau/auth.php', e);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur auth', detail: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// UTILISATEURS
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/users.php', async (req, res) => {
  const { action, id } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    // Essai 1 : avec les colonnes addon (permissions / practice_domains)
    let { data, error } = await supabase.from('users')
      .select('id,username,full_name,email,practice_domains,permissions,role,avatar,active,created_at,last_login')
      .order('role', { ascending: false }).order('full_name');
    // Fallback : colonnes addon absentes → retry sans elles
    if (error && /(permissions|practice_domains|does not exist|schema cache)/i.test(error.message || '')) {
      const fb = await supabase.from('users')
        .select('id,username,full_name,email,role,avatar,active,created_at,last_login')
        .order('role', { ascending: false }).order('full_name');
      data = fb.data; error = fb.error;
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data ?? []);
  }

  if (action === 'create' && req.method === 'POST') {
    const u = await authGuard(req, res, 'super_admin'); if (!u) return;
    const { username, full_name, email, role, password, practice_domains, permissions } = req.body;
    if (!username || !full_name || !password) return res.status(400).json({ error: 'Champs requis manquants' });
    const pd =
      typeof practice_domains === 'string' && practice_domains.trim() !== ''
        ? practice_domains.trim().slice(0, 512).replace(/\s+/g, ' ')
        : null;
    const perms = permissions === undefined ? null : normalizePermissions(permissions);
    const { error } = await supabase.from('users').insert({
      username,
      password: bcrypt.hashSync(password, 12),
      full_name,
      email: email || null,
      practice_domains: pd,
      permissions: perms,
      role: role || 'agent',
      first_login: true,
      active: true,
    });
    if (error) return res.status(409).json({ error: "Ce nom d'utilisateur existe déjà" });
    return res.json({ success: true });
  }

  if (action === 'update' && req.method === 'PUT') {
    const u = await authGuard(req, res, 'super_admin'); if (!u) return;
    const { username, full_name, email, role, active, practice_domains, permissions } = req.body;
    const pd =
      typeof practice_domains === 'string'
        ? (practice_domains.trim() === '' ? null : practice_domains.trim().slice(0, 512).replace(/\s+/g, ' '))
        : undefined;
    const row = {
      username,
      full_name,
      email,
      role,
      active: active ?? true,
      ...(pd !== undefined ? { practice_domains: pd } : {}),
      ...(permissions !== undefined ? { permissions: normalizePermissions(permissions) } : {}),
    };
    await supabase.from('users').update(row).eq('id', +id);
    return res.json({ success: true });
  }

  if (action === 'delete' && req.method === 'DELETE') {
    const u = await authGuard(req, res, 'super_admin'); if (!u) return;
    if (+id === u.id) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
    await supabase.from('users').update({ active: false }).eq('id', +id);
    return res.json({ success: true });
  }

  if (action === 'reset_password' && req.method === 'POST') {
    const u = await authGuard(req, res, 'super_admin'); if (!u) return;
    const nw = req.body.password;
    if (!nw || typeof nw !== 'string' || nw.length < 8)
      return res.status(422).json({ error: 'Mot de passe trop court (min 8 caractères)' });
    await supabase.from('users').update({ password: bcrypt.hashSync(nw, 12), first_login: true }).eq('id', +id);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// PROJETS
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/projects.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'projects')) return;
  const { action, id } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res); if (!u) return;
    const { data } = await supabase
      .from('projects')
      .select('*, assigned_user:users!assigned_to(full_name)')
      .order('created_at', { ascending: false });
    return res.json((data ?? []).map(p => ({ ...p, agent_name: p.assigned_user?.full_name ?? null, assigned_user: undefined })));
  }

  if (action === 'stats') {
    const u = await authGuard(req, res); if (!u) return;
    const [{ count: total }, { count: en_cours }, { count: termine }, { count: en_pause }, { data: bud }] = await Promise.all([
      supabase.from('projects').select('*', { count: 'exact', head: true }),
      supabase.from('projects').select('*', { count: 'exact', head: true }).eq('status', 'en_cours'),
      supabase.from('projects').select('*', { count: 'exact', head: true }).eq('status', 'termine'),
      supabase.from('projects').select('*', { count: 'exact', head: true }).eq('status', 'en_pause'),
      supabase.from('projects').select('budget').neq('status', 'annule'),
    ]);
    const budget_total = (bud ?? []).reduce((s, p) => s + (p.budget ?? 0), 0);
    return res.json({ total, en_cours, termine, en_pause, budget_total });
  }

  if (action === 'create' && req.method === 'POST') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    const b = req.body;
    const { data, error } = await supabase.from('projects')
      .insert({ name: b.name, client: b.client, description: b.description || null, status: b.status || 'en_cours', priority: b.priority || 'normale', budget: +b.budget || 0, deadline: b.deadline || null, assigned_to: b.assigned_to || null, created_by: u.id })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, id: data.id });
  }

  if (action === 'update' && req.method === 'PUT') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    const b = req.body;
    await supabase.from('projects')
      .update({ name: b.name, client: b.client, description: b.description || null, status: b.status, priority: b.priority, budget: +b.budget || 0, deadline: b.deadline || null, assigned_to: b.assigned_to || null, progress: +b.progress || 0 })
      .eq('id', +id);
    return res.json({ success: true });
  }

  if (action === 'delete' && req.method === 'DELETE') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    await supabase.from('projects').delete().eq('id', +id);
    return res.json({ success: true });
  }

  if (action === 'update_meta' && req.method === 'PUT') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    const b = req.body || {};
    const update = {};
    if (b.case_number !== undefined)      update.case_number = b.case_number ? String(b.case_number).trim().slice(0, 80) : null;
    if (b.practice_area !== undefined)    update.practice_area = b.practice_area ? String(b.practice_area).trim().slice(0, 80) : null;
    if (b.current_phase !== undefined)    update.current_phase = b.current_phase ? String(b.current_phase).trim().slice(0, 240) : null;
    if (b.next_action !== undefined)      update.next_action = b.next_action ? String(b.next_action).trim().slice(0, 500) : null;
    if (b.next_action_date !== undefined) update.next_action_date = b.next_action_date || null;
    const { error } = await supabase.from('projects').update(update).eq('id', +id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// CASES — Dossiers juridiques (sous-collections : milestones, events, documents)
// Réutilise la perm 'projects' (un dossier = un projet enrichi).
// ══════════════════════════════════════════════════════════════════════════════
const CASE_DOC_MAX = 10 * 1024 * 1024; // 10 Mo par document
const CASE_DOC_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png', 'image/webp',
  'text/plain',
]);

function caseDocBytea(buf) { return '\\x' + buf.toString('hex'); }

/** Génère un PDF de facture (Buffer) — design sobre A4 portrait. */
async function buildInvoicePdfBuffer({ invoice, payments, project, clients }) {
  if (!PDFDocument) throw new Error('Module pdfkit absent — npm install pdfkit');
  return await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // En-tête cabinet
      doc.fontSize(20).fillColor('#1a1a1a').font('Helvetica-Bold').text('AFRILEX CONSEIL', { align: 'left' });
      doc.fontSize(9).fillColor('#666').font('Helvetica').text('Cabinet d\'avocats — droit des affaires & contentieux', { align: 'left' });
      doc.text('Ouagadougou, Burkina Faso · cabinet@afrilexconseil.com · +226 52 20 91 91');
      doc.moveDown(0.5);
      doc.strokeColor('#cc6644').lineWidth(2).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(1.2);

      // Titre + n° facture
      doc.fontSize(22).fillColor('#cc6644').font('Helvetica-Bold').text('FACTURE', { align: 'right' });
      doc.fontSize(10).fillColor('#333').font('Helvetica');
      doc.text(`N° ${invoice.invoice_number || '—'}`, { align: 'right' });
      doc.text(`Date d'émission : ${invoice.sent_at ? new Date(invoice.sent_at).toLocaleDateString('fr-FR') : new Date(invoice.created_at).toLocaleDateString('fr-FR')}`, { align: 'right' });
      if (invoice.due_date) doc.text(`Échéance : ${new Date(invoice.due_date).toLocaleDateString('fr-FR')}`, { align: 'right' });
      doc.moveDown(2);

      // Client(s) destinataire(s)
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a1a1a').text('FACTURÉ À :');
      doc.font('Helvetica').fillColor('#333');
      if (clients && clients.length > 0) {
        for (const c of clients) {
          doc.text(c.name + (c.company ? ` (${c.company})` : ''));
          if (c.email) doc.text(c.email);
          if (c.phone) doc.text(c.phone);
        }
      } else {
        doc.text('—');
      }
      doc.moveDown(0.8);

      // Référence dossier
      doc.font('Helvetica-Bold').text('DOSSIER :', { continued: true }).font('Helvetica').text(` ${project?.case_number || '—'} — ${project?.name || ''}`);
      doc.moveDown(1.5);

      // Tableau — ligne unique (intitulé + montant)
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#fff');
      doc.rect(40, doc.y, 515, 24).fill('#cc6644');
      const ty = doc.y - 22;
      doc.fillColor('#fff').text('DÉSIGNATION', 50, ty + 6);
      doc.text('MONTANT', 450, ty + 6, { width: 95, align: 'right' });
      doc.moveDown(2);

      const fmtMoney = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} ${invoice.currency === 'XOF' ? 'FCFA' : invoice.currency}`;

      doc.fillColor('#1a1a1a').font('Helvetica');
      const itemY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').text(invoice.title, 50, itemY, { width: 380 });
      if (invoice.description) {
        doc.fontSize(9).font('Helvetica').fillColor('#666').text(invoice.description, 50, doc.y, { width: 380 });
      }
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a');
      doc.text(fmtMoney(invoice.amount), 450, itemY, { width: 95, align: 'right' });

      doc.moveDown(2);
      doc.strokeColor('#ccc').lineWidth(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.5);

      // Totaux
      const totalDue = Number(invoice.amount) - Number(invoice.paid_amount || 0);
      const block = (label, val, color = '#1a1a1a', bold = false) => {
        const y = doc.y;
        doc.fontSize(10).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color);
        doc.text(label, 350, y, { width: 100, align: 'right' });
        doc.text(val, 450, y, { width: 95, align: 'right' });
        doc.moveDown(0.4);
      };
      block('Total HT/TTC', fmtMoney(invoice.amount), '#1a1a1a', true);
      if (Number(invoice.paid_amount || 0) > 0) block('Déjà réglé', '- ' + fmtMoney(invoice.paid_amount), '#3a8c3a');
      block('SOLDE DÛ', fmtMoney(totalDue), totalDue > 0 ? '#cc6644' : '#3a8c3a', true);

      // Paiements détail
      if (payments && payments.length > 0) {
        doc.moveDown(1);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a1a1a').text('Historique des paiements :');
        doc.font('Helvetica').fontSize(9).fillColor('#333');
        const methodLabels = { especes: 'Espèces', virement: 'Virement', mobile_money: 'Mobile Money', cheque: 'Chèque', carte: 'Carte', autre: 'Autre' };
        for (const p of payments) {
          doc.text(`• ${new Date(p.paid_at).toLocaleDateString('fr-FR')} — ${fmtMoney(p.amount)} (${methodLabels[p.method] || p.method}${p.reference ? ` · réf ${p.reference}` : ''})`);
        }
      }

      // Note client
      if (invoice.notes_client) {
        doc.moveDown(1.5);
        doc.fontSize(9).fillColor('#666').font('Helvetica-Oblique').text('Note : ' + invoice.notes_client, { width: 515 });
      }

      // Footer
      doc.fontSize(8).fillColor('#999').font('Helvetica');
      doc.text('Afrilex Conseil SARL · cabinet@afrilexconseil.com · Ouagadougou (Burkina Faso)',
        40, 780, { align: 'center', width: 515 });
      doc.text(`Document généré le ${new Date().toLocaleString('fr-FR')}`, 40, 795, { align: 'center', width: 515 });

      doc.end();
    } catch (e) { reject(e); }
  });
}

function caseDocBufFromRow(d) {
  if (!d) return null;
  if (typeof d === 'string' && d.startsWith('\\x')) return Buffer.from(d.slice(2), 'hex');
  if (typeof d === 'string') return Buffer.from(d, 'base64');
  if (Buffer.isBuffer(d)) return d;
  return null;
}

app.all('/api/bureau/cases.php', async (req, res) => {
  try {
    if (!(await authGuard(req, res))) return;
    if (!permGuard(req, res, 'projects')) return;
    const u = req.user;
    const isAdmin = u.role === 'admin' || u.role === 'super_admin';
    const isSuperAdmin = u.role === 'super_admin';
    const { action, id } = req.query;

    // ── Vue 360° d'un dossier ──────────────────────────────────────────────────
    if (action === 'get' && req.method === 'GET') {
      const projectId = +id;
      const { data: project, error: pErr } = await supabase
        .from('projects')
        .select('*, assigned_user:users!assigned_to(full_name)')
        .eq('id', projectId)
        .maybeSingle();
      if (pErr) return res.status(500).json({ error: pErr.message });
      if (!project) return res.status(404).json({ error: 'Dossier introuvable' });

      const [milestones, events, documents, links] = await Promise.all([
        supabase.from('case_milestones').select('*, completed_by_user:users!completed_by(full_name)').eq('project_id', projectId).order('order_index').order('created_at'),
        supabase.from('case_events').select('*, created_by_user:users!created_by(full_name)').eq('project_id', projectId).order('scheduled_at'),
        supabase.from('case_documents').select('id, title, kind, description, filename, mime, size_bytes, uploaded_by_user_id, uploaded_by_client_id, visible_to_client, confidential, created_at, uploader_user:users!uploaded_by_user_id(full_name), uploader_client:clients!uploaded_by_client_id(name)').eq('project_id', projectId).order('created_at', { ascending: false }),
        supabase.from('case_clients').select('role, added_at, client:clients(id,name,email,company,phone,active)').eq('project_id', projectId),
      ]);

      return res.json({
        project: { ...project, agent_name: project.assigned_user?.full_name ?? null, assigned_user: undefined },
        milestones: (milestones.data ?? []).map((m) => ({ ...m, completed_by_name: m.completed_by_user?.full_name ?? null, completed_by_user: undefined })),
        events:     (events.data     ?? []).map((e) => ({ ...e, created_by_name: e.created_by_user?.full_name ?? null, created_by_user: undefined })),
        documents:  (documents.data  ?? []).map((d) => ({
          ...d,
          uploader_user: undefined, uploader_client: undefined,
          uploaded_by_name: d.uploader_user?.full_name ?? d.uploader_client?.name ?? null,
          uploaded_by_kind: d.uploaded_by_user_id ? 'cabinet' : (d.uploaded_by_client_id ? 'client' : 'inconnu'),
        })),
        clients: (links.data ?? []).map((l) => ({ ...l.client, role: l.role, added_at: l.added_at, client: undefined })),
      });
    }

    // ── Lier / délier un client au dossier ─────────────────────────────────────
    if (action === 'attach_client' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const projectId = +id;
      const clientId = +req.body?.client_id;
      const role = String(req.body?.role || 'principal').slice(0, 40);
      if (!clientId) return res.status(400).json({ error: 'client_id requis' });
      const { error } = await supabase.from('case_clients').upsert({ project_id: projectId, client_id: clientId, role, added_by: u.id }, { onConflict: 'project_id,client_id' });
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'detach_client' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const projectId = +id;
      const clientId = +req.query?.client_id;
      if (!clientId) return res.status(400).json({ error: 'client_id requis' });
      const { error } = await supabase.from('case_clients').delete().eq('project_id', projectId).eq('client_id', clientId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── Milestones (étapes) ────────────────────────────────────────────────────
    if (action === 'milestone_create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const projectId = +id;
      const b = req.body || {};
      const payload = {
        project_id: projectId,
        title: String(b.title ?? '').trim().slice(0, 240),
        description: b.description ? String(b.description).slice(0, 4000) : null,
        due_date: b.due_date || null,
        status: ['a_faire','en_cours','termine','reporte','annule'].includes(b.status) ? b.status : 'a_faire',
        order_index: Number.isFinite(+b.order_index) ? +b.order_index : 0,
        visible_to_client: b.visible_to_client !== false,
        created_by: u.id,
      };
      if (!payload.title) return res.status(400).json({ error: 'Titre requis' });
      const { data, error } = await supabase.from('case_milestones').insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, milestone: data });
    }
    if (action === 'milestone_update' && req.method === 'PUT') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const milestoneId = +id;
      const b = req.body || {};
      const update = {};
      if (b.title !== undefined)             update.title = String(b.title).slice(0, 240);
      if (b.description !== undefined)       update.description = b.description ? String(b.description).slice(0, 4000) : null;
      if (b.due_date !== undefined)          update.due_date = b.due_date || null;
      if (b.status !== undefined && ['a_faire','en_cours','termine','reporte','annule'].includes(b.status)) update.status = b.status;
      if (b.order_index !== undefined && Number.isFinite(+b.order_index)) update.order_index = +b.order_index;
      if (b.visible_to_client !== undefined) update.visible_to_client = !!b.visible_to_client;
      // Si on passe à "termine" et que completed_at est vide → marquer maintenant
      if (update.status === 'termine') {
        update.completed_at = new Date().toISOString();
        update.completed_by = u.id;
      }
      if (b.status && b.status !== 'termine') {
        update.completed_at = null;
        update.completed_by = null;
      }
      const { error } = await supabase.from('case_milestones').update(update).eq('id', milestoneId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'milestone_delete' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const { error } = await supabase.from('case_milestones').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── Events (audiences/RDV/échéances) ───────────────────────────────────────
    if (action === 'event_create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const projectId = +id;
      const b = req.body || {};
      const payload = {
        project_id: projectId,
        type: ['audience','rdv','echeance','depot_pieces','consultation','autre'].includes(b.type) ? b.type : 'rdv',
        title: String(b.title ?? '').trim().slice(0, 240),
        location: b.location ? String(b.location).trim().slice(0, 300) : null,
        scheduled_at: b.scheduled_at,
        duration_minutes: Number.isFinite(+b.duration_minutes) ? +b.duration_minutes : 60,
        notes_internal: b.notes_internal ? String(b.notes_internal).slice(0, 4000) : null,
        notes_client_facing: b.notes_client_facing ? String(b.notes_client_facing).slice(0, 4000) : null,
        visible_to_client: b.visible_to_client !== false,
        created_by: u.id,
      };
      if (!payload.title) return res.status(400).json({ error: 'Titre requis' });
      if (!payload.scheduled_at) return res.status(400).json({ error: 'Date/heure requise' });
      const { data, error } = await supabase.from('case_events').insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      // Notification mail clients liés (async fire-and-forget)
      if (payload.visible_to_client) {
        (async () => {
          const { data: links } = await supabase.from('case_clients').select('client:clients(email,name)').eq('project_id', projectId);
          for (const l of (links ?? [])) {
            if (l.client?.email) {
              const dt = new Date(payload.scheduled_at).toLocaleString('fr-FR');
              await notifyClientByEmail({
                to: l.client.email,
                subject: `Afrilex Conseil — Nouvel événement : ${payload.title}`,
                text: `Bonjour ${l.client.name || ''},\n\nUn nouvel événement a été ajouté à votre dossier :\n\n${payload.title}\n📅 ${dt}${payload.location ? `\n📍 ${payload.location}` : ''}${payload.notes_client_facing ? `\n\n${payload.notes_client_facing}` : ''}\n\nConnectez-vous à votre espace client : https://www.afrilexconseil.com/client\n\nCordialement,\nL'équipe Afrilex Conseil`,
              });
            }
          }
        })().catch(() => {});
      }
      return res.json({ success: true, event: data });
    }
    if (action === 'event_update' && req.method === 'PUT') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const eventId = +id;
      const b = req.body || {};
      const update = {};
      if (b.type !== undefined && ['audience','rdv','echeance','depot_pieces','consultation','autre'].includes(b.type)) update.type = b.type;
      if (b.title !== undefined)               update.title = String(b.title).slice(0, 240);
      if (b.location !== undefined)            update.location = b.location ? String(b.location).slice(0, 300) : null;
      if (b.scheduled_at !== undefined)        update.scheduled_at = b.scheduled_at;
      if (b.duration_minutes !== undefined)    update.duration_minutes = +b.duration_minutes || 60;
      if (b.notes_internal !== undefined)      update.notes_internal = b.notes_internal ? String(b.notes_internal).slice(0, 4000) : null;
      if (b.notes_client_facing !== undefined) update.notes_client_facing = b.notes_client_facing ? String(b.notes_client_facing).slice(0, 4000) : null;
      if (b.visible_to_client !== undefined)   update.visible_to_client = !!b.visible_to_client;
      if (b.completed_at !== undefined)        update.completed_at = b.completed_at || null;
      if (b.outcome !== undefined)             update.outcome = b.outcome ? String(b.outcome).slice(0, 4000) : null;
      const { error } = await supabase.from('case_events').update(update).eq('id', eventId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'event_delete' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const { error } = await supabase.from('case_events').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── Documents (upload base64 JSON, comme blog/cv) ──────────────────────────
    if (action === 'document_upload' && req.method === 'POST') {
      const projectId = +id;
      const b = req.body || {};
      const mime = String(b.mime || '');
      if (!CASE_DOC_MIMES.has(mime)) return res.status(415).json({ error: 'Type non supporté (PDF/DOC/DOCX/XLS/XLSX/JPG/PNG/WEBP/TXT).' });
      if (typeof b.data_base64 !== 'string' || b.data_base64.length < 64) return res.status(400).json({ error: 'data_base64 absent ou invalide' });
      const buf = Buffer.from(b.data_base64.replace(/^data:[^,]+,/, ''), 'base64');
      if (buf.length === 0) return res.status(400).json({ error: 'Document vide' });
      if (buf.length > CASE_DOC_MAX) return res.status(413).json({ error: `Document trop lourd (max ${CASE_DOC_MAX/1024/1024} Mo)` });
      const payload = {
        project_id: projectId,
        title: String(b.title ?? b.filename ?? 'Document').trim().slice(0, 240),
        kind: ['preuve','contrat','jugement','conclusions','expertise','correspondance','identite','autre'].includes(b.kind) ? b.kind : 'autre',
        description: b.description ? String(b.description).slice(0, 4000) : null,
        filename: b.filename ? String(b.filename).slice(0, 240) : null,
        mime,
        size_bytes: buf.length,
        data: caseDocBytea(buf),
        uploaded_by_user_id: u.id,
        visible_to_client: b.visible_to_client !== false,
        confidential: !!b.confidential,
      };
      const { data, error } = await supabase.from('case_documents')
        .insert(payload)
        .select('id, title, kind, description, filename, mime, size_bytes, visible_to_client, confidential, created_at')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      // Notif mail clients liés (async, uniquement si visible et non confidentiel)
      if (payload.visible_to_client && !payload.confidential) {
        (async () => {
          const { data: links } = await supabase.from('case_clients').select('client:clients(email,name)').eq('project_id', projectId);
          for (const l of (links ?? [])) {
            if (l.client?.email) {
              await notifyClientByEmail({
                to: l.client.email,
                subject: `Afrilex Conseil — Nouveau document : ${payload.title}`,
                text: `Bonjour ${l.client.name || ''},\n\nUn nouveau document a été ajouté à votre dossier :\n\n📄 ${payload.title} (${payload.kind})${payload.description ? `\n\n${payload.description}` : ''}\n\nConsultez-le depuis votre espace client : https://www.afrilexconseil.com/client\n\nCordialement,\nL'équipe Afrilex Conseil`,
              });
            }
          }
        })().catch(() => {});
      }
      return res.json({ success: true, document: data });
    }
    if (action === 'document_update' && req.method === 'PUT') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const docId = +id;
      const b = req.body || {};
      const update = {};
      if (b.title !== undefined)             update.title = String(b.title).slice(0, 240);
      if (b.kind !== undefined && ['preuve','contrat','jugement','conclusions','expertise','correspondance','identite','autre'].includes(b.kind)) update.kind = b.kind;
      if (b.description !== undefined)       update.description = b.description ? String(b.description).slice(0, 4000) : null;
      if (b.visible_to_client !== undefined) update.visible_to_client = !!b.visible_to_client;
      if (b.confidential !== undefined)      update.confidential = !!b.confidential;
      const { error } = await supabase.from('case_documents').update(update).eq('id', docId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'document_delete' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const { error } = await supabase.from('case_documents').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'document' && req.method === 'GET') {
      // Téléchargement (côté bureau, peu importe la visibilité client)
      const docId = +id;
      const { data, error } = await supabase.from('case_documents').select('title, filename, mime, data').eq('id', docId).maybeSingle();
      if (error) return res.status(500).send(error.message);
      if (!data) return res.status(404).send('Document introuvable');
      const buf = caseDocBufFromRow(data.data);
      if (!buf) return res.status(500).send('Format binaire inconnu');
      const filename = (data.filename || data.title || `doc-${docId}`).replace(/[\r\n"]/g, '_');
      res.set({
        'Content-Type': data.mime || 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store, private',
      });
      return res.end(buf);
    }

    // Suppression seule (super_admin)
    if (action === 'delete_case' && req.method === 'DELETE') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Réservé au super administrateur.' });
      // Sup les dossier (cascade prend documents/milestones/events/case_clients)
      const { error } = await supabase.from('projects').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── HONORAIRES (factures + paiements) ───────────────────────────────────
    if (action === 'invoices_list' && req.method === 'GET') {
      const projectId = +id;
      const [{ data: invoices }, { data: payments }] = await Promise.all([
        supabase.from('case_invoices').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
        supabase.from('case_payments').select('*, invoice:case_invoices!invoice_id(project_id)').order('paid_at', { ascending: false }),
      ]);
      const projectPayments = (payments ?? []).filter((p) => p.invoice?.project_id === projectId).map((p) => ({ ...p, invoice: undefined }));
      return res.json({ invoices: invoices ?? [], payments: projectPayments });
    }
    if (action === 'invoice_create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const projectId = +id;
      const b = req.body || {};
      const payload = {
        project_id: projectId,
        invoice_number: b.invoice_number ? String(b.invoice_number).trim().slice(0, 80) : null,
        title: String(b.title ?? '').trim().slice(0, 240),
        description: b.description ? String(b.description).slice(0, 4000) : null,
        amount: Number.isFinite(+b.amount) ? +b.amount : 0,
        currency: b.currency ? String(b.currency).slice(0, 8) : 'XOF',
        status: ['brouillon','envoyee','partiellement_payee','payee','annulee'].includes(b.status) ? b.status : 'brouillon',
        due_date: b.due_date || null,
        notes_internal: b.notes_internal ? String(b.notes_internal).slice(0, 4000) : null,
        notes_client: b.notes_client ? String(b.notes_client).slice(0, 4000) : null,
        visible_to_client: b.visible_to_client !== false,
        sent_at: b.status === 'envoyee' ? new Date().toISOString() : null,
        created_by: u.id,
      };
      if (!payload.title) return res.status(400).json({ error: 'Titre requis' });
      const { data, error } = await supabase.from('case_invoices').insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, invoice: data });
    }
    if (action === 'invoice_update' && req.method === 'PUT') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const invoiceId = +id;
      const b = req.body || {};
      const update = {};
      if (b.invoice_number !== undefined) update.invoice_number = b.invoice_number ? String(b.invoice_number).slice(0, 80) : null;
      if (b.title !== undefined)          update.title = String(b.title).slice(0, 240);
      if (b.description !== undefined)    update.description = b.description ? String(b.description).slice(0, 4000) : null;
      if (b.amount !== undefined && Number.isFinite(+b.amount)) update.amount = +b.amount;
      if (b.currency !== undefined)       update.currency = String(b.currency).slice(0, 8);
      if (b.status !== undefined && ['brouillon','envoyee','partiellement_payee','payee','annulee'].includes(b.status)) {
        update.status = b.status;
        if (b.status === 'envoyee') update.sent_at = new Date().toISOString();
      }
      if (b.due_date !== undefined)       update.due_date = b.due_date || null;
      if (b.notes_internal !== undefined) update.notes_internal = b.notes_internal ? String(b.notes_internal).slice(0, 4000) : null;
      if (b.notes_client !== undefined)   update.notes_client = b.notes_client ? String(b.notes_client).slice(0, 4000) : null;
      if (b.visible_to_client !== undefined) update.visible_to_client = !!b.visible_to_client;
      const { error } = await supabase.from('case_invoices').update(update).eq('id', invoiceId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'invoice_delete' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const { error } = await supabase.from('case_invoices').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'payment_record' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const invoiceId = +id;
      const b = req.body || {};
      const amount = +b.amount;
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
      // Insertion du paiement
      const { error: pErr } = await supabase.from('case_payments').insert({
        invoice_id: invoiceId,
        amount,
        paid_at: b.paid_at || new Date().toISOString().slice(0, 10),
        method: ['especes','virement','mobile_money','cheque','carte','autre'].includes(b.method) ? b.method : 'autre',
        reference: b.reference ? String(b.reference).slice(0, 240) : null,
        notes: b.notes ? String(b.notes).slice(0, 2000) : null,
        recorded_by: u.id,
      });
      if (pErr) return res.status(500).json({ error: pErr.message });
      // Recalcul du paid_amount + statut auto
      const { data: inv } = await supabase.from('case_invoices').select('amount').eq('id', invoiceId).maybeSingle();
      const { data: pays } = await supabase.from('case_payments').select('amount').eq('invoice_id', invoiceId);
      const total = (pays ?? []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const status = total >= Number(inv?.amount || 0) ? 'payee' : (total > 0 ? 'partiellement_payee' : 'envoyee');
      await supabase.from('case_invoices').update({ paid_amount: total, paid_at: new Date().toISOString(), status }).eq('id', invoiceId);
      return res.json({ success: true, paid_amount: total, status });
    }
    if (action === 'payment_delete' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const paymentId = +id;
      const { data: pay } = await supabase.from('case_payments').select('invoice_id').eq('id', paymentId).maybeSingle();
      if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
      await supabase.from('case_payments').delete().eq('id', paymentId);
      // Recalc
      const { data: inv } = await supabase.from('case_invoices').select('amount').eq('id', pay.invoice_id).maybeSingle();
      const { data: pays } = await supabase.from('case_payments').select('amount').eq('invoice_id', pay.invoice_id);
      const total = (pays ?? []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const status = total >= Number(inv?.amount || 0) ? 'payee' : (total > 0 ? 'partiellement_payee' : 'envoyee');
      await supabase.from('case_invoices').update({ paid_amount: total, status }).eq('id', pay.invoice_id);
      return res.json({ success: true, paid_amount: total, status });
    }

    // ── DEMANDES DE RDV (workflow) ──────────────────────────────────────────
    if (action === 'event_requests_list' && req.method === 'GET') {
      const projectId = +id;
      let q = supabase.from('case_event_requests')
        .select('*, requester:clients!client_id(name,email), decider:users!decided_by(full_name)')
        .order('created_at', { ascending: false });
      if (projectId) q = q.eq('project_id', projectId);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.json((data ?? []).map((r) => ({
        ...r,
        requester_name: r.requester?.name ?? null,
        requester_email: r.requester?.email ?? null,
        decided_by_name: r.decider?.full_name ?? null,
        requester: undefined, decider: undefined,
      })));
    }
    if (action === 'event_request_decide' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const requestId = +id;
      const b = req.body || {};
      const decision = String(b.decision ?? '').toLowerCase();
      if (!['accepted','rescheduled','refused'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });
      const { data: reqRow } = await supabase.from('case_event_requests').select('*').eq('id', requestId).maybeSingle();
      if (!reqRow) return res.status(404).json({ error: 'Demande introuvable' });
      const update = {
        status: decision,
        decided_at: new Date().toISOString(),
        decided_by: u.id,
        decided_message: b.message ? String(b.message).slice(0, 2000) : null,
      };
      let scheduledEventId = null;
      // Si accepté ou reprogrammé → créer un case_event lié
      if (decision === 'accepted' || decision === 'rescheduled') {
        const finalDate = decision === 'rescheduled' && b.scheduled_at ? b.scheduled_at : reqRow.proposed_date;
        const { data: ev, error: evErr } = await supabase.from('case_events').insert({
          project_id: reqRow.project_id,
          type: reqRow.type,
          title: reqRow.title,
          location: b.location ? String(b.location).slice(0, 300) : null,
          scheduled_at: finalDate,
          duration_minutes: Number.isFinite(+b.duration_minutes) ? +b.duration_minutes : 60,
          notes_client_facing: b.notes_client_facing ? String(b.notes_client_facing).slice(0, 4000) : (reqRow.message ? `Demandé par le client : « ${reqRow.message} »` : null),
          notes_internal: b.notes_internal ? String(b.notes_internal).slice(0, 4000) : null,
          visible_to_client: true,
          created_by: u.id,
        }).select().single();
        if (evErr) return res.status(500).json({ error: evErr.message });
        scheduledEventId = ev.id;
        update.scheduled_event_id = scheduledEventId;
      }
      const { error } = await supabase.from('case_event_requests').update(update).eq('id', requestId);
      if (error) return res.status(500).json({ error: error.message });
      sendWhatsApp(`📅 Demande RDV ${decision === 'accepted' ? '✅ acceptée' : decision === 'rescheduled' ? '↻ reprogrammée' : '❌ refusée'}\nClient #${reqRow.client_id}\n${reqRow.title}\n${update.decided_message ? `\nMessage : ${update.decided_message}` : ''}`);
      return res.json({ success: true, scheduled_event_id: scheduledEventId });
    }

    // ── DILIGENCES (time-tracking interne) ──────────────────────────────────
    if (action === 'activities_list' && req.method === 'GET') {
      const projectId = +id;
      const { data, error } = await supabase.from('case_activities')
        .select('*, agent:users!user_id(full_name)')
        .eq('project_id', projectId)
        .order('date', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json((data ?? []).map((a) => ({ ...a, agent_name: a.agent?.full_name ?? null, agent: undefined })));
    }
    if (action === 'activity_create' && req.method === 'POST') {
      const projectId = +id;
      const b = req.body || {};
      const duration = Number.isFinite(+b.duration_minutes) ? +b.duration_minutes : 0;
      const rate = Number.isFinite(+b.hourly_rate) ? +b.hourly_rate : null;
      const amount = b.amount != null && Number.isFinite(+b.amount) ? +b.amount : (rate != null ? Math.round((duration / 60) * rate) : null);
      const payload = {
        project_id: projectId,
        user_id: u.id,
        kind: ['consultation','redaction','audience','recherche','rdv','expertise','telephone','email','autre'].includes(b.kind) ? b.kind : 'autre',
        title: String(b.title ?? '').trim().slice(0, 240),
        description: b.description ? String(b.description).slice(0, 4000) : null,
        date: b.date || new Date().toISOString().slice(0, 10),
        duration_minutes: duration,
        billable: b.billable !== false,
        hourly_rate: rate,
        amount,
      };
      if (!payload.title) return res.status(400).json({ error: 'Titre requis' });
      const { data, error } = await supabase.from('case_activities').insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, activity: data });
    }
    if (action === 'activity_update' && req.method === 'PUT') {
      const activityId = +id;
      const b = req.body || {};
      const update = {};
      if (b.kind !== undefined && ['consultation','redaction','audience','recherche','rdv','expertise','telephone','email','autre'].includes(b.kind)) update.kind = b.kind;
      if (b.title !== undefined)            update.title = String(b.title).slice(0, 240);
      if (b.description !== undefined)      update.description = b.description ? String(b.description).slice(0, 4000) : null;
      if (b.date !== undefined)             update.date = b.date;
      if (b.duration_minutes !== undefined) update.duration_minutes = +b.duration_minutes || 0;
      if (b.billable !== undefined)         update.billable = !!b.billable;
      if (b.hourly_rate !== undefined)      update.hourly_rate = b.hourly_rate ? +b.hourly_rate : null;
      if (b.amount !== undefined)           update.amount = b.amount != null ? +b.amount : null;
      if (b.invoice_id !== undefined)       update.invoice_id = b.invoice_id ? +b.invoice_id : null;
      const { error } = await supabase.from('case_activities').update(update).eq('id', activityId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'activity_delete' && req.method === 'DELETE') {
      const activityId = +id;
      // Tout agent peut supprimer ses propres activités, admin+ peut supprimer toutes
      if (!isAdmin) {
        const { data: a } = await supabase.from('case_activities').select('user_id').eq('id', activityId).maybeSingle();
        if (!a || a.user_id !== u.id) return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres diligences.' });
      }
      const { error } = await supabase.from('case_activities').delete().eq('id', activityId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── PDF FACTURE (téléchargement) ─────────────────────────────────────────
    if (action === 'invoice_pdf' && req.method === 'GET') {
      const invoiceId = +id;
      const { data: invoice } = await supabase.from('case_invoices').select('*').eq('id', invoiceId).maybeSingle();
      if (!invoice) return res.status(404).send('Facture introuvable');
      const [{ data: project }, { data: payments }, { data: links }] = await Promise.all([
        supabase.from('projects').select('id, name, case_number, practice_area').eq('id', invoice.project_id).maybeSingle(),
        supabase.from('case_payments').select('*').eq('invoice_id', invoiceId).order('paid_at'),
        supabase.from('case_clients').select('client:clients(name,email,phone,company)').eq('project_id', invoice.project_id),
      ]);
      const clients = (links ?? []).map((l) => l.client).filter(Boolean);
      try {
        const buf = await buildInvoicePdfBuffer({ invoice, payments: payments ?? [], project, clients });
        const filename = `facture-${invoice.invoice_number || invoice.id}.pdf`;
        res.set({
          'Content-Type': 'application/pdf',
          'Content-Length': String(buf.length),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store, private',
        });
        return res.end(buf);
      } catch (e) {
        console.error('invoice_pdf', e);
        return res.status(500).send(String(e?.message || e));
      }
    }

    // ── SIGNATURES électroniques ─────────────────────────────────────────────
    if (action === 'signatures_list' && req.method === 'GET') {
      const projectId = +id;
      const { data, error } = await supabase
        .from('case_signatures')
        .select('*, client:clients!client_id(name,email), creator:users!created_by(full_name)')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json((data ?? []).map((s) => ({
        ...s,
        client_name: s.client?.name ?? null, client_email: s.client?.email ?? null,
        created_by_name: s.creator?.full_name ?? null,
        client: undefined, creator: undefined,
        // ne PAS renvoyer signed_ip / signed_user_agent au front (sensibles, juste preuve back)
      })));
    }
    if (action === 'signature_create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const projectId = +id;
      const b = req.body || {};
      if (!b.title || !b.content_text || !b.client_id) return res.status(400).json({ error: 'Titre, contenu et client requis.' });
      const payload = {
        project_id: projectId,
        document_id: b.document_id ? +b.document_id : null,
        client_id: +b.client_id,
        title: String(b.title).slice(0, 240),
        content_text: String(b.content_text).slice(0, 20000),
        expires_at: b.expires_at || null,
        created_by: u.id,
      };
      const { data, error } = await supabase.from('case_signatures').insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      // Notif mail au client
      (async () => {
        const { data: cli } = await supabase.from('clients').select('email,name').eq('id', payload.client_id).maybeSingle();
        if (cli?.email) {
          await notifyClientByEmail({
            to: cli.email,
            subject: `Afrilex Conseil — Document à signer : ${payload.title}`,
            text: `Bonjour ${cli.name || ''},\n\nUn document attend votre signature dans votre espace client :\n\n📄 ${payload.title}\n\nConnectez-vous pour le consulter et signer : https://www.afrilexconseil.com/client\n\nCordialement,\nL'équipe Afrilex Conseil`,
          });
        }
      })().catch(() => {});
      return res.json({ success: true, signature: data });
    }
    if (action === 'signature_cancel' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const sigId = +id;
      const { error } = await supabase.from('case_signatures').update({ status: 'cancelled' }).eq('id', sigId).eq('status', 'pending');
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }
    if (action === 'signature_delete' && req.method === 'DELETE') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Réservé au super administrateur.' });
      const { error } = await supabase.from('case_signatures').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── TEMPLATES de dossier ─────────────────────────────────────────────────
    if (action === 'templates_list' && req.method === 'GET') {
      const { data, error } = await supabase.from('case_templates').select('*').eq('is_active', true).order('name');
      if (error) {
        const missing = /(relation .* does not exist|Could not find the table|schema cache)/i.test(error.message || '');
        return res.status(missing ? 503 : 500).json({
          error: missing
            ? "Table 'case_templates' absente. Exécutez sql/supabase_phase3_addon.sql dans Supabase SQL Editor."
            : error.message,
          missing_table: missing ? 'case_templates' : undefined,
        });
      }
      return res.json(data ?? []);
    }
    if (action === 'template_apply' && req.method === 'POST') {
      // Crée un projet from template + génère ses milestones (mode robuste : 2 INSERT en cas
      // de colonnes manquantes — supporte schéma de base sans supabase_cases_addon.sql)
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const templateId = +id;
      const b = req.body || {};
      const { data: tpl, error: tplErr } = await supabase
        .from('case_templates').select('*').eq('id', templateId).maybeSingle();
      if (tplErr) {
        const missing = /(relation .* does not exist|Could not find the table|schema cache)/i.test(tplErr.message || '');
        return res.status(missing ? 503 : 500).json({
          error: missing
            ? "Table 'case_templates' absente. Exécutez sql/supabase_phase3_addon.sql."
            : tplErr.message,
        });
      }
      if (!tpl) return res.status(404).json({ error: 'Modèle introuvable' });

      // ── 1) INSERT minimal (colonnes garanties par le schéma de base)
      const baseProject = {
        name:        String(b.name || tpl.name).slice(0, 240),
        client:      String(b.client || '').trim().slice(0, 240) || 'À renseigner',
        description: b.description || tpl.description || null,
        status:      tpl.default_status   || 'en_cours',
        priority:    tpl.default_priority || 'normale',
        created_by:  u.id,
      };
      const { data: project, error: pErr } = await supabase
        .from('projects').insert(baseProject).select().single();
      if (pErr) {
        console.error('template_apply projects.insert error:', pErr.message);
        return res.status(500).json({
          error: `Création du dossier impossible : ${pErr.message}`,
          hint: 'Vérifiez la table projects et les contraintes (name, client requis).',
        });
      }

      // ── 2) UPDATE optionnel pour colonnes addon (silencieux si absentes)
      const optional = {};
      if (tpl.practice_area) optional.practice_area = tpl.practice_area;
      if (b.case_number)     optional.case_number   = String(b.case_number).slice(0, 80);
      if (Object.keys(optional).length > 0) {
        const { error: oErr } = await supabase.from('projects').update(optional).eq('id', project.id);
        if (oErr && !/column .* does not exist|schema cache/i.test(oErr.message || '')) {
          console.warn('template_apply update meta non bloquant:', oErr.message);
        }
      }

      // ── 3) Génération milestones (idempotent : on continue même si la table addon manque)
      const baseDate = new Date(b.start_date || Date.now());
      let milestonesCount = 0, milestonesWarning = null;
      const ms = (tpl.milestones_json || [])
        .filter((m) => m && m.title && String(m.title).trim())
        .map((m, i) => {
          const due = new Date(baseDate);
          due.setDate(due.getDate() + (Number(m.due_offset_days) || 0));
          return {
            project_id: project.id,
            title:       String(m.title).slice(0, 240),
            description: m.description ? String(m.description).slice(0, 4000) : null,
            due_date:    due.toISOString().slice(0, 10),
            order_index: Number(m.order_index) || (i + 1) * 10,
            visible_to_client: m.visible_to_client !== false,
            status:      'a_faire',
            created_by:  u.id,
          };
        });
      if (ms.length) {
        const { error: msErr } = await supabase.from('case_milestones').insert(ms);
        if (msErr) {
          milestonesWarning = msErr.message;
          console.warn('template_apply case_milestones non créées:', msErr.message);
        } else {
          milestonesCount = ms.length;
        }
      }

      // ── 4) Génération events (idem)
      let eventsCount = 0, eventsWarning = null;
      const evs = (tpl.events_json || [])
        .filter((e) => e && e.title)
        .map((e) => {
          const sched = new Date(baseDate);
          sched.setDate(sched.getDate() + (Number(e.scheduled_offset_days) || 0));
          return {
            project_id: project.id,
            type:       ['audience','rdv','echeance','depot_pieces','consultation','autre'].includes(e.type) ? e.type : 'rdv',
            title:      String(e.title).slice(0, 240),
            location:   e.location || null,
            scheduled_at: sched.toISOString(),
            duration_minutes: Number(e.duration_minutes) || 60,
            visible_to_client: e.visible_to_client !== false,
            created_by: u.id,
          };
        });
      if (evs.length) {
        const { error: evErr } = await supabase.from('case_events').insert(evs);
        if (evErr) {
          eventsWarning = evErr.message;
          console.warn('template_apply case_events non créés:', evErr.message);
        } else {
          eventsCount = evs.length;
        }
      }

      return res.json({
        success: true,
        project,
        milestones_count: milestonesCount,
        events_count: eventsCount,
        warnings: (milestonesWarning || eventsWarning) ? {
          milestones: milestonesWarning,
          events: eventsWarning,
          hint: "Exécutez sql/supabase_cases_addon.sql pour activer les étapes / événements de dossier.",
        } : undefined,
      });
    }
    if (action === 'template_create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const b = req.body || {};
      // Normalisation profonde des étapes (évite tout payload mal formé qui ferait planter le JSONB)
      const cleanMs = (Array.isArray(b.milestones_json) ? b.milestones_json : [])
        .filter((m) => m && typeof m === 'object' && String(m.title || '').trim())
        .map((m, i) => ({
          title: String(m.title).trim().slice(0, 240),
          description: m.description ? String(m.description).trim().slice(0, 4000) : '',
          due_offset_days: Number.isFinite(+m.due_offset_days) ? +m.due_offset_days : 0,
          order_index: Number.isFinite(+m.order_index) ? +m.order_index : (i + 1) * 10,
          visible_to_client: m.visible_to_client !== false,
        }));
      const cleanEvs = (Array.isArray(b.events_json) ? b.events_json : [])
        .filter((e) => e && typeof e === 'object' && String(e.title || '').trim())
        .map((e) => ({
          type: ['audience','rdv','echeance','depot_pieces','consultation','autre'].includes(e.type) ? e.type : 'rdv',
          title: String(e.title).trim().slice(0, 240),
          location: e.location ? String(e.location).slice(0, 300) : '',
          scheduled_offset_days: Number.isFinite(+e.scheduled_offset_days) ? +e.scheduled_offset_days : 0,
          duration_minutes: Number.isFinite(+e.duration_minutes) ? +e.duration_minutes : 60,
          visible_to_client: e.visible_to_client !== false,
        }));
      const payload = {
        name: String(b.name || '').trim().slice(0, 240),
        description: b.description ? String(b.description).slice(0, 4000) : null,
        practice_area: b.practice_area ? String(b.practice_area).slice(0, 80) : null,
        default_status: b.default_status || 'en_cours',
        default_priority: b.default_priority || 'normale',
        milestones_json: cleanMs,
        events_json: cleanEvs,
        is_active: b.is_active !== false,
        created_by: u.id,
      };
      if (!payload.name) return res.status(400).json({ error: 'Le nom du modèle est obligatoire.' });
      if (cleanMs.length === 0) return res.status(400).json({ error: 'Ajoutez au moins une étape avec un titre.' });
      const { data, error } = await supabase.from('case_templates').insert(payload).select().single();
      if (error) {
        console.error('template_create error:', error.message);
        const missing = /(relation .* does not exist|Could not find the table|schema cache)/i.test(error.message || '');
        return res.status(missing ? 503 : 500).json({
          error: missing
            ? "Table 'case_templates' absente. Exécutez sql/supabase_phase3_addon.sql dans Supabase SQL Editor (Supabase Dashboard > SQL Editor > Run)."
            : `Impossible d'enregistrer le modèle : ${error.message}`,
        });
      }
      return res.json({ success: true, template: data });
    }
    if (action === 'template_update' && req.method === 'PUT') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const tplId = +id;
      const b = req.body || {};
      // Sanitise : ne garde que les colonnes connues + normalise les JSON
      const allowed = ['name','description','practice_area','default_status','default_priority','milestones_json','events_json','is_active'];
      const payload = {};
      for (const k of allowed) if (k in b) payload[k] = b[k];
      if (payload.milestones_json !== undefined) {
        payload.milestones_json = (Array.isArray(payload.milestones_json) ? payload.milestones_json : [])
          .filter((m) => m && typeof m === 'object' && String(m.title || '').trim())
          .map((m, i) => ({
            title: String(m.title).trim().slice(0, 240),
            description: m.description ? String(m.description).trim().slice(0, 4000) : '',
            due_offset_days: Number.isFinite(+m.due_offset_days) ? +m.due_offset_days : 0,
            order_index: Number.isFinite(+m.order_index) ? +m.order_index : (i + 1) * 10,
            visible_to_client: m.visible_to_client !== false,
          }));
      }
      if (payload.events_json !== undefined) {
        payload.events_json = (Array.isArray(payload.events_json) ? payload.events_json : [])
          .filter((e) => e && typeof e === 'object' && String(e.title || '').trim());
      }
      if (Object.keys(payload).length === 0) return res.status(400).json({ error: 'Aucune modification fournie.' });
      const { error } = await supabase.from('case_templates').update(payload).eq('id', tplId);
      if (error) {
        console.error('template_update error:', error.message);
        return res.status(500).json({ error: `Mise à jour impossible : ${error.message}` });
      }
      return res.json({ success: true });
    }
    if (action === 'template_delete' && req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const { error } = await supabase.from('case_templates').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('cases.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MISSIONS
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/missions.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'missions')) return;
  const { action, id } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res); if (!u) return;
    let q = supabase.from('missions')
      .select('*, assignee:users!assigned_to(full_name), project:projects!project_id(name)')
      .order('created_at', { ascending: false });
    if (u.role === 'agent') q = q.eq('assigned_to', u.id);
    const { data } = await q;
    return res.json((data ?? []).map(m => ({ ...m, assignee: undefined, project: undefined, assignee_name: m.assignee?.full_name ?? null, project_name: m.project?.name ?? null })));
  }

  if (action === 'create' && req.method === 'POST') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    const b = req.body;
    await supabase.from('missions').insert({ title: b.title, description: b.description || null, project_id: b.project_id || null, assigned_to: +b.assigned_to, assigned_by: u.id, status: b.status || 'a_faire', due_date: b.due_date || null });
    return res.json({ success: true });
  }

  if (action === 'update' && req.method === 'PUT') {
    const u = await authGuard(req, res); if (!u) return;
    const b = req.body;
    if (u.role === 'agent') {
      await supabase.from('missions').update({ status: b.status }).eq('id', +id).eq('assigned_to', u.id);
    } else {
      await supabase.from('missions').update({ title: b.title, description: b.description || null, status: b.status, due_date: b.due_date || null, assigned_to: +b.assigned_to }).eq('id', +id);
    }
    return res.json({ success: true });
  }

  if (action === 'delete' && req.method === 'DELETE') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    await supabase.from('missions').delete().eq('id', +id);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// RH — Workflow congés / absences à 2 niveaux
//   • Agent : crée ses propres demandes (conge/absence/retard/note), voit ses propres records
//   • Admin : valide / refuse les demandes (étape intermédiaire), peut créer des records pour autrui
//   • Super_admin : décision finale (peut overrider l'admin), supprimer
// Workflow statuts : en_attente → valide_admin → approuve  (ou refuse à n'importe quelle étape)
// ══════════════════════════════════════════════════════════════════════════════
const HR_TYPES_ALLOWED = ['conge', 'absence', 'retard', 'prime', 'note'];
const HR_TYPES_AGENT_REQUEST = ['conge', 'absence', 'retard', 'note']; // pas de "prime" pour l'agent

const HR_SELECT_FIELDS =
  '*, employee:users!user_id(full_name,email), creator:users!created_by(full_name), ' +
  'admin_user:users!admin_decision_by(full_name), super_admin_user:users!super_admin_decision_by(full_name)';

function shapeHrRecord(h) {
  if (!h) return h;
  return {
    ...h,
    employee_name:           h.employee?.full_name ?? null,
    employee_email:          h.employee?.email ?? null,
    created_by_name:         h.creator?.full_name ?? null,
    admin_decision_by_name:  h.admin_user?.full_name ?? null,
    super_admin_decision_by_name: h.super_admin_user?.full_name ?? null,
    employee: undefined,
    creator: undefined,
    admin_user: undefined,
    super_admin_user: undefined,
  };
}

app.all('/api/bureau/hr.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'hr')) return;
  const user = req.user;
  const isAgent = user.role === 'agent';
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';
  const isSuperAdmin = user.role === 'super_admin';
  const { action, id } = req.query;

  try {
    // ── Liste / Mine ─────────────────────────────────────────────────────────
    if (action === 'list' || action === 'mine') {
      let q = supabase.from('hr_records').select(HR_SELECT_FIELDS).order('created_at', { ascending: false });
      // Agent : forcé à ne voir que ses propres records
      if (isAgent || action === 'mine') q = q.eq('user_id', user.id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.json((data ?? []).map(shapeHrRecord));
    }

    if (action === 'stats') {
      // Stats globales (admin+) ou personnelles (agent)
      const baseFilter = (qb) => isAgent ? qb.eq('user_id', user.id) : qb;
      const [
        { count: total },
        { count: en_attente },
        { count: valide_admin },
        { count: refuse_admin },
        { count: approuve },
        { count: refuse },
        { count: conges },
        { data: primes },
      ] = await Promise.all([
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })),
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })).eq('status', 'en_attente'),
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })).eq('status', 'valide_admin'),
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })).eq('status', 'refuse_admin'),
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })).eq('status', 'approuve'),
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })).eq('status', 'refuse'),
        baseFilter(supabase.from('hr_records').select('*', { count: 'exact', head: true })).eq('type', 'conge'),
        baseFilter(supabase.from('hr_records').select('amount')).eq('type', 'prime').eq('status', 'approuve'),
      ]);
      return res.json({
        total: total ?? 0,
        en_attente: en_attente ?? 0,
        valide_admin: valide_admin ?? 0,
        refuse_admin: refuse_admin ?? 0,
        approuve: approuve ?? 0,
        refuse: refuse ?? 0,
        total_conges: conges ?? 0,
        total_primes: (primes ?? []).reduce((s, h) => s + (h.amount ?? 0), 0),
      });
    }

    // ── Agent (et + ) crée sa propre demande (workflow obligatoire) ─────────
    if (action === 'request' && req.method === 'POST') {
      const b = req.body || {};
      const type = String(b.type ?? '').trim();
      if (!HR_TYPES_AGENT_REQUEST.includes(type)) {
        return res.status(400).json({ error: `Type non autorisé pour une demande : ${HR_TYPES_AGENT_REQUEST.join(', ')}` });
      }
      const title = String(b.title ?? '').trim().slice(0, 240);
      if (!title) return res.status(400).json({ error: 'Titre requis (ex: « Congé annuel — semaine 18 »).' });
      const startDate = b.start_date ? String(b.start_date).slice(0, 10) : null;
      const endDate = b.end_date ? String(b.end_date).slice(0, 10) : (startDate || null);
      if ((type === 'conge' || type === 'absence') && (!startDate || !endDate)) {
        return res.status(400).json({ error: 'Dates de début et de fin requises pour une demande de congé ou d\'absence.' });
      }
      if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
        return res.status(400).json({ error: 'La date de début doit être antérieure ou égale à la date de fin.' });
      }
      const description = b.description ? String(b.description).slice(0, 4000) : null;
      const payload = {
        user_id: user.id,                      // toujours soi-même
        type,
        title,
        description,
        date: startDate || new Date().toISOString().slice(0, 10),
        start_date: startDate,
        end_date: endDate,
        amount: 0,
        status: 'en_attente',
        requires_workflow: true,
        submitted_at: new Date().toISOString(),
        created_by: user.id,
      };
      const { data, error } = await supabase.from('hr_records').insert(payload).select(HR_SELECT_FIELDS).single();
      if (error) return res.status(500).json({ error: error.message });
      sendWhatsApp(`📋 *Nouvelle demande RH — ${title}*\n👤 ${user.full_name}\n📂 Type : ${type}${startDate ? `\n📅 Du ${startDate} au ${endDate}` : ''}\n\n🔗 /bureau/rh\n⏰ ${new Date().toLocaleString('fr-FR')}`);
      return res.json({ success: true, record: shapeHrRecord(data) });
    }

    // ── Admin+ crée un record (peut inclure prime, peut être directement approuvé) ─
    if (action === 'create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const b = req.body || {};
      const type = String(b.type ?? '').trim();
      if (!HR_TYPES_ALLOWED.includes(type)) return res.status(400).json({ error: 'Type invalide.' });
      const targetUserId = b.user_id ? +b.user_id : user.id;
      const title = String(b.title ?? '').trim().slice(0, 240);
      if (!title) return res.status(400).json({ error: 'Titre requis.' });
      const startDate = b.start_date ? String(b.start_date).slice(0, 10) : (b.date ? String(b.date).slice(0, 10) : null);
      const endDate = b.end_date ? String(b.end_date).slice(0, 10) : startDate;
      // Statut initial : admin peut directement approuver/refuser pour les types "prime", "note"
      // ou laisser en_attente pour conge/absence/retard (workflow standard)
      let initialStatus = String(b.status || 'en_attente');
      if (!['en_attente', 'valide_admin', 'refuse_admin', 'approuve', 'refuse'].includes(initialStatus)) initialStatus = 'en_attente';
      const payload = {
        user_id: targetUserId,
        type,
        title,
        description: b.description ? String(b.description).slice(0, 4000) : null,
        date: startDate || new Date().toISOString().slice(0, 10),
        start_date: startDate,
        end_date: endDate,
        amount: Number.isFinite(+b.amount) ? +b.amount : 0,
        status: initialStatus,
        requires_workflow: (type === 'conge' || type === 'absence' || type === 'retard'),
        submitted_at: new Date().toISOString(),
        created_by: user.id,
      };
      const { data, error } = await supabase.from('hr_records').insert(payload).select(HR_SELECT_FIELDS).single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, record: shapeHrRecord(data) });
    }

    // ── Décision admin (valider / refuser — étape intermédiaire) ────────────
    if (action === 'decide' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const b = req.body || {};
      const recordId = +id;
      const decision = String(b.decision ?? '').toLowerCase();
      const level = String(b.level ?? '').toLowerCase(); // 'admin' ou 'super_admin'
      const comment = b.comment ? String(b.comment).slice(0, 2000) : null;

      if (!['valide', 'refuse', 'approuve'].includes(decision)) {
        return res.status(400).json({ error: 'Décision invalide : valide | refuse | approuve.' });
      }
      if (!['admin', 'super_admin'].includes(level)) {
        return res.status(400).json({ error: 'Niveau invalide : admin | super_admin.' });
      }
      if (level === 'super_admin' && !isSuperAdmin) {
        return res.status(403).json({ error: 'Seul le super administrateur peut prendre la décision finale.' });
      }

      const now = new Date().toISOString();
      const update = {};
      let newStatus = null;

      if (level === 'admin') {
        if (decision === 'valide') {
          update.admin_decision = 'valide';
          newStatus = 'valide_admin';
        } else if (decision === 'refuse') {
          update.admin_decision = 'refuse';
          newStatus = 'refuse_admin';
        } else {
          return res.status(400).json({ error: 'Décision admin doit être valide ou refuse.' });
        }
        update.admin_decision_at = now;
        update.admin_decision_by = user.id;
        if (comment !== null) update.admin_comment = comment;
      } else {
        // super_admin : décision finale (peut overrider l'admin)
        if (decision === 'approuve') {
          update.super_admin_decision = 'approuve';
          newStatus = 'approuve';
        } else if (decision === 'refuse') {
          update.super_admin_decision = 'refuse';
          newStatus = 'refuse';
        } else {
          return res.status(400).json({ error: 'Décision super_admin doit être approuve ou refuse.' });
        }
        update.super_admin_decision_at = now;
        update.super_admin_decision_by = user.id;
        if (comment !== null) update.super_admin_comment = comment;
      }
      update.status = newStatus;

      const { data, error } = await supabase
        .from('hr_records')
        .update(update)
        .eq('id', recordId)
        .select(HR_SELECT_FIELDS)
        .single();
      if (error) return res.status(500).json({ error: error.message });

      const shaped = shapeHrRecord(data);
      // Notification WhatsApp à l'étape suivante du workflow
      const employeeName = shaped.employee_name ?? '?';
      if (level === 'admin' && decision === 'valide') {
        sendWhatsApp(`✅ *Demande RH validée par admin*\n👤 ${employeeName}\n📋 ${shaped.title}\n\nEn attente de décision finale super-admin.\n🔗 /bureau/rh\n⏰ ${new Date().toLocaleString('fr-FR')}`);
      } else if (level === 'super_admin') {
        const verb = decision === 'approuve' ? '✅ APPROUVÉE' : '❌ REFUSÉE';
        sendWhatsApp(`${verb} *(décision finale)*\n👤 ${employeeName}\n📋 ${shaped.title}\n👮 Par : ${user.full_name}${comment ? `\n💬 ${comment}` : ''}\n⏰ ${new Date().toLocaleString('fr-FR')}`);
      }
      return res.json({ success: true, record: shaped });
    }

    // ── Update générique (admin+ : description, statut direct, montant) ──────
    if (action === 'update' && req.method === 'PUT') {
      if (!isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
      const b = req.body || {};
      const update = {};
      if (b.status && ['en_attente','valide_admin','refuse_admin','approuve','refuse'].includes(b.status)) update.status = b.status;
      if (b.description !== undefined) update.description = b.description ? String(b.description).slice(0, 4000) : null;
      if (b.title !== undefined) update.title = String(b.title).slice(0, 240);
      if (b.amount !== undefined && Number.isFinite(+b.amount)) update.amount = +b.amount;
      if (b.start_date !== undefined) update.start_date = b.start_date || null;
      if (b.end_date !== undefined) update.end_date = b.end_date || null;
      const { error } = await supabase.from('hr_records').update(update).eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── Suppression (super_admin uniquement) ─────────────────────────────────
    if (action === 'delete' && req.method === 'DELETE') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Réservé au super administrateur.' });
      const { error } = await supabase.from('hr_records').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('hr.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// COMPTABILITÉ
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/accounting.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'accounting')) return;
  const { action, id } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res); if (!u) return;
    const { data } = await supabase.from('accounting')
      .select('*, created_by_user:users!created_by(full_name), project:projects!project_id(name)')
      .order('date', { ascending: false });
    return res.json((data ?? []).map(a => ({ ...a, created_by_user: undefined, project: undefined, created_by_name: a.created_by_user?.full_name ?? null, project_name: a.project?.name ?? null })));
  }

  if (action === 'stats') {
    const u = await authGuard(req, res); if (!u) return;
    const [{ data: rec }, { data: dep }, { data: all }] = await Promise.all([
      supabase.from('accounting').select('amount').eq('type', 'recette'),
      supabase.from('accounting').select('amount').eq('type', 'depense'),
      supabase.from('accounting').select('date,type,amount').order('date', { ascending: false }),
    ]);
    const recettes = (rec ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
    const depenses = (dep ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
    const grouped  = {};
    (all ?? []).forEach(({ date, type, amount }) => {
      const month = (date ?? '').slice(0, 7);
      const key   = `${month}|${type}`;
      if (!grouped[key]) grouped[key] = { month, type, total: 0 };
      grouped[key].total += amount ?? 0;
    });
    return res.json({ recettes, depenses, solde: recettes - depenses, by_month: Object.values(grouped).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 24) });
  }

  if (action === 'create' && req.method === 'POST') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    const b = req.body;
    await supabase.from('accounting').insert({ type: b.type, category: b.category, amount: +b.amount, description: b.description, project_id: b.project_id || null, date: b.date, created_by: u.id });
    return res.json({ success: true });
  }

  if (action === 'delete' && req.method === 'DELETE') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    await supabase.from('accounting').delete().eq('id', +id);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// CHAT INTERNE
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/messages.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'chat')) return;
  const { action, since, channel } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res); if (!u) return;
    const ch = channel || 'general';
    // Pour les DMs, vérifier que l'utilisateur fait partie du canal
    if (String(ch).startsWith('dm:')) {
      const parts = String(ch).replace('dm:', '').split('-');
      if (!parts.includes(String(u.id))) return res.status(403).json({ error: 'Accès refusé' });
    }
    let q = supabase.from('messages').select('*, sender:users!sender_id(full_name)')
      .eq('channel', ch).order('created_at');
    if (since) q = q.gt('id', +since);
    else q = q.limit(100);
    const { data } = await q;
    return res.json((data ?? []).map(m => ({ ...m, sender: undefined, sender_name: m.sender?.full_name ?? null })));
  }

  if (action === 'send' && req.method === 'POST') {
    const u = await authGuard(req, res); if (!u) return;
    if (!req.body.content?.trim()) return res.status(400).json({ error: 'Message vide' });
    const ch = req.body.channel || 'general';
    // Pour les DMs, vérifier que l'utilisateur fait partie du canal
    if (String(ch).startsWith('dm:')) {
      const parts = String(ch).replace('dm:', '').split('-');
      if (!parts.includes(String(u.id))) return res.status(403).json({ error: 'Accès refusé' });
    }
    const { data } = await supabase.from('messages')
      .insert({ sender_id: u.id, channel: ch, content: req.body.content.trim() })
      .select('*, sender:users!sender_id(full_name)').single();
    return res.json({ success: true, message: data ? { ...data, sender: undefined, sender_name: data.sender?.full_name } : null });
  }

  // Comptage des non-lus DM pour l'utilisateur courant
  if (action === 'unread_dms') {
    const u = await authGuard(req, res); if (!u) return;
    const { data } = await supabase.from('messages')
      .select('channel, sender_id')
      .like('channel', 'dm:%')
      .gt('id', +(req.query.since_id || 0));
    /** @type {Record<string, number>} */
    const unread = {};
    (data ?? []).forEach(m => {
      const parts = String(m.channel).replace('dm:', '').split('-');
      if (parts.includes(String(u.id)) && String(m.sender_id) !== String(u.id)) {
        unread[m.channel] = (unread[m.channel] || 0) + 1;
      }
    });
    return res.json(unread);
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// RETOURS CLIENTS (feedback)
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/feedback.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'feedback')) return;
  const { action, id } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res); if (!u) return;
    const { data } = await supabase.from('feedback')
      .select('*, project:projects!project_id(name)').order('created_at', { ascending: false });
    return res.json((data ?? []).map(f => ({ ...f, project: undefined, project_name: f.project?.name ?? null })));
  }

  if (action === 'create' && req.method === 'POST') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    const b = req.body;
    await supabase.from('feedback').insert({ client_name: b.client_name, project_id: b.project_id || null, rating: +b.rating || 5, comment: b.comment || null, category: b.category || 'satisfaction', status: 'nouveau' });
    return res.json({ success: true });
  }

  if (action === 'update' && req.method === 'PUT') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    await supabase.from('feedback').update({ status: req.body.status }).eq('id', +id);
    return res.json({ success: true });
  }

  if (action === 'delete' && req.method === 'DELETE') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    await supabase.from('feedback').delete().eq('id', +id);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEMANDES / LEADS
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/bureau/leads.php', async (req, res) => {
  if (!(await authGuard(req, res))) return;
  if (!permGuard(req, res, 'leads')) return;
  const { action, id } = req.query;

  if (action === 'list') {
    const u = await authGuard(req, res); if (!u) return;
    const { data } = await supabase.from('leads')
      .select('*, agent:users!assigned_to(full_name)').order('created_at', { ascending: false });
    return res.json((data ?? []).map(l => ({ ...l, agent: undefined, agent_name: l.agent?.full_name ?? null })));
  }

  if (action === 'stats') {
    const u = await authGuard(req, res); if (!u) return;
    const ck = async (st) =>
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', st);
    const [{ count: total }, { count: nouveau }, { count: en_cours }, { count: converti }, { count: perdu }, { count: archive }] = await Promise.all([
      supabase.from('leads').select('*', { count: 'exact', head: true }),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'nouveau'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'en_cours'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'converti'),
      ck('perdu'),
      ck('archive'),
    ]);
    return res.json({ total, nouveau, en_cours, converti, perdu, archive });
  }

  if (action === 'assignees') {
    const u = await authGuard(req, res); if (!u) return;
    const LEAD_DOMS = ['juridique', 'fiscal', 'comptabilite', 'structuration', 'investissement', 'autre', 'non_classe'];
    const forDomain = String(req.query.for_domain || '').trim().toLowerCase();
    const { data } = await supabase
      .from('users')
      .select('id, full_name, role, practice_domains')
      .eq('active', true)
      .in('role', ['agent', 'admin', 'super_admin'])
      .order('full_name');
    let rows = data ?? [];
    if (forDomain && LEAD_DOMS.includes(forDomain)) {
      rows = rows.filter((r) => userHandlesLeadDomain(r.practice_domains, forDomain));
    }
    return res.json(rows);
  }

  if (action === 'update' && req.method === 'PUT') {
    const u = await authGuard(req, res); if (!u) return;
    const patch = {};
    const { status, assigned_to, notes, domain } = req.body ?? {};
    if (status !== undefined) patch.status = status;
    if (assigned_to !== undefined) patch.assigned_to = assigned_to || null;
    if (notes !== undefined) patch.notes = notes;
    if (domain !== undefined) patch.domain = domain;
    if (!Object.keys(patch).length) return res.status(422).json({ error: 'Aucune donnée à mettre à jour' });
    await supabase.from('leads').update(patch).eq('id', +id);
    return res.json({ success: true });
  }

  if (action === 'delete' && req.method === 'DELETE') {
    const u = await authGuard(req, res, 'admin'); if (!u) return;
    await supabase.from('leads').delete().eq('id', +id);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// ASSISTANT RÉDACTION (Groq — clé serveur uniquement)
// ══════════════════════════════════════════════════════════════════════════════
function buildAssistantSystem(mode, kb, dossierBlock) {
  const base =
    '# Rappels de prudence\n' +
    "- L'outil produit des **brouillons** ou des pistes rédactionnelles. Il ne substitue pas l'examen humain ni un avis professionnel définitif.\n" +
    '- Ne cite pas comme acquises sans preuve les références légales ou jurisprudentielles : indique‑les après **les avoir vérifiées** sur les sources officielles ou avec l’avis interne qui s’appuie sur dossier réel.\n' +
    "- Base synthétique (non exhaustive) fournie ci-dessous ; **ne présume pas** d'autres règles que celles dont tu disposes :\n\n" +
    (kb.trim() ? kb.trim() + '\n\n---\n\n' : '');

  if (mode === 'memo_litige') {
    return (
      `${base}` +
      "Tu aides l'équipe à produire un **brouillon** de mémo argumenté ou de note de synthèse (contentieux ou stratégique).\n" +
      "- Réponds **en français** sauf si l'utilisateur demande explicitement une autre langue.\n" +
      '- Structure claire : problématiques, exposition des faits, arguments, contre-arguments envisageables, demandes concrètes, pièces / preuves à relire.\n' +
      '- Marque comme **[à vérifier]** toute référence à un article, texte officiel OU jurisprudence si tu ne l’as pas sous les yeux.\n' +
      '- Si les faits sont insuffisants, pose au plus **trois questions ciblées** avant de développer trop longtemps.\n' +
      (dossierBlock
        ? `\n## Contexte fourni par l'utilisateur\n${dossierBlock}\n`
        : '')
    );
  }

  return (
    `${base}` +
    "Tu es un assistant rédactionnel pour l'espace bureau **NUMAFRIQ**.\n" +
    '- Aide les agents à préparer dossiers internes : mails, présentations, plans d\'action projet, synthèses, check-lists livrables.\n' +
    '- Réponses **concises puis détaillables** ; ton professionnel bienveillant.\n' +
    '- Réponds **en français** sauf indication contraire.\n' +
    '- Si hors champ digital / gestion projet, reste prudent et propose des formulations neutres.'
  );
}

app.post('/api/bureau/assistant.php', async (req, res) => {
  const u = await authGuard(req, res);
  if (!u) return;
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey || !groqKey.trim()) {
    return res.status(503).json({
      error: 'Assistant désactivé. Définir la variable serveur GROQ_API_KEY (jamais côté client).',
    });
  }

  const {
    mode: rawMode = 'assist',
    messages = [],
    dossier_summary: dossierSummary = '',
  } = req.body ?? {};
  const mode = rawMode === 'memo_litige' ? 'memo_litige' : 'assist';
  const raw = Array.isArray(messages) ? messages : [];
  const sanitized = raw
    .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
    .map((m) => ({
      role: ['assistant', 'user'].includes(m.role) ? m.role : 'user',
      content: String(m.content).slice(0, 14_000),
    }))
    .slice(-22);

  if (!sanitized.length || sanitized[sanitized.length - 1].role !== 'user') {
    return res.status(422).json({ error: 'Fournissez au moins un message utilisateur à la fin de la conversation.' });
  }

  const dossierBlock = dossierSummary ? String(dossierSummary).slice(0, 20_000) : '';
  const system = buildAssistantSystem(mode, loadKbBureauMarkdown(), dossierBlock);

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: system }, ...sanitized],
        temperature: mode === 'memo_litige' ? 0.35 : 0.45,
        max_tokens: 8192,
      }),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const hint = data?.error?.message || upstream.statusText;
      console.error('[assistant]', upstream.status, hint);
      return res.status(502).json({ error: 'Fournisseur LLM indisponible.', detail: hint });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply || typeof reply !== 'string') {
      return res.status(502).json({ error: 'Réponse invalide du modèle.' });
    }
    return res.json({ reply: reply.trim(), mode });
  } catch (e) {
    console.error('[assistant]', e.message);
    return res.status(502).json({ error: 'Erreur lors de l’appel au modèle.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTH CLIENT
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/client/auth.php', async (req, res) => {
  const { action } = req.query;

  if (action === 'register' && req.method === 'POST') {
    const { name, email, password, company, phone } = req.body;
    if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Champs invalides' });
    const { data: client, error } = await supabase.from('clients')
      .insert({ name, email, password: bcrypt.hashSync(password, 12), company: company || null, phone: phone || null, active: true })
      .select().single();
    if (error) return res.status(409).json({ error: 'Email déjà utilisé' });
    await supabase.from('client_messages').insert({ client_id: client.id, sender_type: 'agent', content: `Bonjour ${name} ! 👋 Bienvenue dans votre espace client Afrilex Conseil. Notre équipe est là pour vous accompagner.` });
    sendWhatsApp(`✅ *Nouveau client Afrilex Conseil*\n\n👤 ${name}\n📧 ${email}\n🏢 ${company || 'Non précisé'}\n⏰ ${new Date().toLocaleString('fr-FR')}`);
    const token = makeToken();
    await supabase.from('client_sessions').insert({ client_id: client.id, token, expires_at: in12h() });
    return res.json({ token, client: { id: client.id, name, email, company: company || null, phone: phone || null } });
  }

  if (action === 'login' && req.method === 'POST') {
    const { email, password } = req.body;
    const { data: client } = await supabase.from('clients').select('*').eq('email', email).eq('active', true).single();
    if (!client || !safeComparePassword(password, client.password)) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const token = makeToken();
    await supabase.from('client_sessions').insert({ client_id: client.id, token, expires_at: in12h() });
    return res.json({ token, client: { id: client.id, name: client.name, email: client.email, company: client.company, phone: client.phone } });
  }

  if (action === 'logout' && req.method === 'POST') {
    const m = (req.headers.authorization ?? '').match(/Bearer\s+(.+)/i);
    if (m) await supabase.from('client_sessions').delete().eq('token', m[1]);
    return res.json({ success: true });
  }

  if (action === 'me') {
    const c = await clientGuard(req, res); if (!c) return;
    let project = null;
    if (c.project_id) {
      const { data } = await supabase.from('projects').select('id,name,client,status,progress,deadline,budget').eq('id', c.project_id).single();
      project = data;
    }
    const { count: unread } = await supabase.from('client_messages').select('*', { count: 'exact', head: true }).eq('client_id', c.id).eq('sender_type', 'agent').eq('is_read', false);
    return res.json({ id: c.id, name: c.name, email: c.email, company: c.company, phone: c.phone, project, unread });
  }

  if (action === 'profile' && req.method === 'PUT') {
    const c = await clientGuard(req, res); if (!c) return;
    await supabase.from('clients').update({ name: req.body.name || c.name, company: req.body.company || null, phone: req.body.phone || null }).eq('id', c.id);
    return res.json({ success: true });
  }

  if (action === 'change_password' && req.method === 'POST') {
    const c = await clientGuard(req, res); if (!c) return;
    const { old_password, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
    if (!safeComparePassword(old_password ?? '', c.password)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    await supabase.from('clients').update({ password: bcrypt.hashSync(new_password, 12) }).eq('id', c.id);
    return res.json({ success: true });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGES CLIENTS
// ══════════════════════════════════════════════════════════════════════════════
app.all('/api/client/messages.php', async (req, res) => {
  const { action, since, client_id } = req.query;

  // Client — liste ses messages
  if (action === 'list') {
    const c = await clientGuard(req, res); if (!c) return;
    let q = supabase.from('client_messages').select('*').eq('client_id', c.id).order('created_at');
    if (since) q = q.gt('id', +since); else q = q.limit(100);
    const { data } = await q;
    await supabase.from('client_messages').update({ is_read: true }).eq('client_id', c.id).eq('sender_type', 'agent').eq('is_read', false);
    return res.json(data ?? []);
  }

  // Client — envoie un message
  if (action === 'send' && req.method === 'POST') {
    const c = await clientGuard(req, res); if (!c) return;
    if (!req.body.content?.trim()) return res.status(400).json({ error: 'Message vide' });
    const { data } = await supabase.from('client_messages')
      .insert({ client_id: c.id, sender_type: 'client', content: req.body.content.trim() }).select().single();
    sendWhatsApp(`💬 *Message client*\n👤 ${c.name}\n${req.body.content.trim()}\n⏰ ${new Date().toLocaleString('fr-FR')}`);
    return res.json({ success: true, message: data });
  }

  // Agent — liste les conversations
  if (action === 'conversations') {
    const u = await agentTokenGuard(req, res); if (!u) return;
    if (!permGuard(req, res, 'clients')) return;
    const { data: cls } = await supabase.from('clients').select('id,name,email,company').eq('active', true);
    const result = await Promise.all((cls ?? []).map(async c => {
      const [{ count: unread }, { data: last }] = await Promise.all([
        supabase.from('client_messages').select('*', { count: 'exact', head: true }).eq('client_id', c.id).eq('sender_type', 'client').eq('is_read', false),
        supabase.from('client_messages').select('content,created_at').eq('client_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      return { ...c, unread, last_message: last?.content ?? null, last_message_at: last?.created_at ?? null };
    }));
    return res.json(result.sort((a, b) => new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0)));
  }

  // Agent — fil d'un client
  if (action === 'thread') {
    const u = await agentTokenGuard(req, res); if (!u) return;
    if (!permGuard(req, res, 'clients')) return;
    const { data } = await supabase.from('client_messages')
      .select('*, agent:users!sender_id(full_name)').eq('client_id', +client_id).order('created_at');
    await supabase.from('client_messages').update({ is_read: true }).eq('client_id', +client_id).eq('sender_type', 'client').eq('is_read', false);
    return res.json((data ?? []).map(m => ({ ...m, agent: undefined, agent_name: m.agent?.full_name ?? null })));
  }

  // Agent — réponse à un client
  if (action === 'agent_reply' && req.method === 'POST') {
    const u = await agentTokenGuard(req, res); if (!u) return;
    if (!permGuard(req, res, 'clients')) return;
    const { client_id: cid, content } = req.body;
    if (!cid || !content?.trim()) return res.status(400).json({ error: 'Champs requis' });
    await supabase.from('client_messages').insert({ client_id: +cid, sender_type: 'agent', sender_id: u.id, content: content.trim() });
    return res.json({ success: true });
  }

  // Client — nb non lus
  if (action === 'unread') {
    const c = await clientGuard(req, res); if (!c) return;
    const { count } = await supabase.from('client_messages').select('*', { count: 'exact', head: true }).eq('client_id', c.id).eq('sender_type', 'agent').eq('is_read', false);
    return res.json({ count });
  }

  res.status(404).json({ error: 'Action non trouvée' });
});

// ══════════════════════════════════════════════════════════════════════════════
// FORMULAIRE CONTACT → enregistré en lead
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/contact.php', async (req, res) => {
  const { from_name: name, from_email: email, phone, company, service, budget, timeline, message } = req.body;
  if (!name || !email || !message) return res.status(422).json({ success: false, message: 'Champs requis manquants' });

  const domain = resolveLeadDomain(service);
  const assigned_to = await pickAssigneeUserIdForDomain(domain);
  const payload = {
    name, email,
    phone: phone || null, company: company || null, service: service || null,
    domain,
    budget: budget || null, timeline: timeline || null,
    source: 'contact_web',
    message,
    status: 'nouveau',
    assigned_to,
  };
  const { data, error } = await supabase.from('leads').insert(payload).select().single();

  if (error) return res.status(500).json({ success: false, message: error.message });

  sendWhatsApp(`🔔 *Nouvelle demande Afrilex Conseil*\n\n👤 ${name}\n📧 ${email}\n📞 ${phone || '—'}\n🏢 ${company || '—'}\n🛠 ${service || '—'}\n💰 ${budget || '—'}\n📅 ${timeline || '—'}\n\n💬 ${message}\n\n🔗 /bureau/leads\n⏰ ${new Date().toLocaleString('fr-FR')}`);

  return res.json({ success: true, message: 'Demande enregistrée', id: data?.id });
});

// ══════════════════════════════════════════════════════════════════════════════
// FORMULAIRE CARRIÈRES → enregistré en candidature (job_applications)
// Public POST multipart/form-data (champs texte + fichier `cv`)
// ══════════════════════════════════════════════════════════════════════════════
const APPLICATION_MODES = ['offer', 'profile_pool', 'spontaneous'];
const ALLOWED_CV_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream', // certains navigateurs envoient ça pour .docx
]);

app.post('/api/careers.php', uploadCareersCv.single('cv'), async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot
    if (typeof b.website === 'string' && b.website.trim() !== '') return res.json({ success: true });

    const first_name  = String(b.first_name ?? '').trim().slice(0, 120);
    const last_name   = String(b.last_name  ?? '').trim().slice(0, 120);
    const email       = String(b.email      ?? '').trim().toLowerCase().slice(0, 254);
    const motivation  = String(b.motivation ?? '').trim().slice(0, 8000);
    const consent     = b.consent_data_processing === '1' || b.consent_data_processing === true;
    const locale      = (String(b.locale ?? 'fr').toLowerCase() === 'en') ? 'en' : 'fr';

    if (!first_name || !last_name || !email || !motivation) {
      return res.status(422).json({ success: false, message: locale === 'en' ? 'Missing required fields.' : 'Champs obligatoires manquants.' });
    }
    if (!isEmailish(email)) {
      return res.status(422).json({ success: false, message: locale === 'en' ? 'Invalid email.' : 'Email invalide.' });
    }
    if (motivation.length < 80) {
      return res.status(422).json({ success: false, message: locale === 'en' ? 'Motivation must be at least 80 characters.' : 'Le message de motivation doit contenir au moins 80 caractères.' });
    }
    if (!consent) {
      return res.status(422).json({ success: false, message: locale === 'en' ? 'You must accept the data processing.' : 'Vous devez accepter le traitement de vos données.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(422).json({ success: false, message: locale === 'en' ? 'CV file is required.' : 'Le CV est obligatoire.' });
    }
    const cvBuf = req.file.buffer;
    if (cvBuf.length > 5 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: locale === 'en' ? 'CV is too large (max 5 MB).' : 'CV trop volumineux (max 5 Mo).' });
    }
    const mime = req.file.mimetype || 'application/octet-stream';
    const cvName = (req.file.originalname || 'cv').slice(0, 240);
    if (!ALLOWED_CV_MIMES.has(mime) && !/\.(pdf|docx?|odt)$/i.test(cvName)) {
      return res.status(415).json({ success: false, message: locale === 'en' ? 'Unsupported CV format (PDF / DOC / DOCX).' : 'Format de CV non supporté (PDF / DOC / DOCX).' });
    }

    let application_mode = String(b.application_mode ?? 'offer').toLowerCase();
    if (!APPLICATION_MODES.includes(application_mode)) application_mode = 'offer';

    let position_applied = String(b.position_applied ?? '').trim().slice(0, 80);
    if (application_mode === 'spontaneous') position_applied = 'spontaneous';

    const payload = {
      first_name, last_name, email,
      phone:            b.phone ? String(b.phone).trim().slice(0, 100) : null,
      city_country:     b.city_country ? String(b.city_country).trim().slice(0, 200) : null,
      linkedin_url:     b.linkedin_url ? String(b.linkedin_url).trim().slice(0, 500) : null,
      position_applied: position_applied || 'spontaneous',
      contract_type:    String(b.contract_type ?? 'discuss').trim().slice(0, 40),
      availability:     b.availability ? String(b.availability).trim().slice(0, 160) : null,
      experience_years: b.experience_years ? String(b.experience_years).trim().slice(0, 24) : null,
      education_level:  b.education_level ? String(b.education_level).trim().slice(0, 48) : null,
      languages:        b.languages ? String(b.languages).trim().slice(0, 400) : null,
      motivation,
      application_mode,
      job_offer_ref:    application_mode === 'offer' && b.job_offer_ref ? String(b.job_offer_ref).trim().slice(0, 120) : null,
      sought_role_title: application_mode === 'profile_pool' && b.sought_role_title ? String(b.sought_role_title).trim().slice(0, 255) : null,
      cv_original_name: cvName,
      cv_mime:          mime,
      cv_data:          '\\x' + cvBuf.toString('hex'),
      cv_size_bytes:    cvBuf.length,
      locale,
      consent_data_processing: true,
      status: 'nouveau',
    };

    const { data, error } = await supabase.from('job_applications').insert(payload).select('id').single();
    if (error) {
      console.error('careers insert', error);
      const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
      return res.status(missing ? 503 : 500).json({
        success: false,
        message: missing
          ? 'Table job_applications absente — exécutez sql/supabase_inbox_addon.sql.'
          : (locale === 'en' ? 'Server error while saving application.' : 'Erreur serveur lors de l\'enregistrement.'),
      });
    }

    sendWhatsApp(`📨 *Nouvelle candidature Afrilex Conseil*\n\n👤 ${first_name} ${last_name}\n📧 ${email}\n📞 ${payload.phone || '—'}\n🛠 Poste : ${position_applied}\n📂 Mode : ${application_mode}${payload.job_offer_ref ? `\n🔖 Réf. offre : ${payload.job_offer_ref}` : ''}\n📎 CV : ${cvName} (${(cvBuf.length / 1024).toFixed(0)} Ko)\n\n💬 ${motivation.slice(0, 240)}${motivation.length > 240 ? '…' : ''}\n\n🔗 /bureau/inbox\n⏰ ${new Date().toLocaleString('fr-FR')}`);

    return res.json({
      success: true,
      message: locale === 'en' ? 'Application received. We will contact you shortly.' : 'Candidature reçue. Nous reviendrons vers vous rapidement.',
      id: data?.id,
    });
  } catch (e) {
    console.error('POST /api/careers.php', e);
    return res.status(500).json({ success: false, message: String(e?.message || e) });
  }
});

// Petit handler d'erreur multer (taille / type) → réponse JSON propre
app.use((err, _req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(413).json({ success: false, message: `Upload rejeté : ${err.message}` });
  }
  return next(err);
});

// ══════════════════════════════════════════════════════════════════════════════
// CANDIDATURES (admin) — CRUD + téléchargement du CV
// ══════════════════════════════════════════════════════════════════════════════
const APPLICATION_PUBLIC_COLUMNS =
  'id, first_name, last_name, email, phone, city_country, linkedin_url, ' +
  'position_applied, contract_type, availability, experience_years, education_level, languages, ' +
  'motivation, application_mode, job_offer_ref, sought_role_title, ' +
  'cv_original_name, cv_mime, cv_size_bytes, locale, consent_data_processing, ' +
  'status, notes, assigned_to, created_at, updated_at';

app.all('/api/bureau/applications.php', async (req, res) => {
  try {
    if (!(await authGuard(req, res))) return;
    if (!permGuard(req, res, 'leads')) return; // partage la perm "leads" (boîte de réception unifiée)
    const { action, id } = req.query;

    if (action === 'list' && req.method === 'GET') {
      const { data, error } = await supabase
        .from('job_applications')
        .select(`${APPLICATION_PUBLIC_COLUMNS}, agent:users!assigned_to(full_name)`)
        .order('created_at', { ascending: false });
      if (error) {
        const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
        return res.status(missing ? 503 : 500).json({
          error: missing ? 'Table job_applications absente — exécutez sql/supabase_inbox_addon.sql.' : error.message,
        });
      }
      return res.json((data ?? []).map((r) => ({ ...r, agent: undefined, agent_name: r.agent?.full_name ?? null })));
    }

    if (action === 'stats' && req.method === 'GET') {
      const counts = {};
      const all = ['nouveau', 'examine', 'entretien', 'refuse', 'embauche', 'archive'];
      const [{ count: total }] = await Promise.all([
        supabase.from('job_applications').select('*', { count: 'exact', head: true }),
      ]);
      for (const st of all) {
        const { count } = await supabase.from('job_applications').select('*', { count: 'exact', head: true }).eq('status', st);
        counts[st] = count ?? 0;
      }
      return res.json({ total, ...counts });
    }

    if (action === 'update' && req.method === 'PUT') {
      const u = await authGuard(req, res); if (!u) return;
      const b = req.body || {};
      const update = {};
      if (typeof b.status === 'string') update.status = b.status;
      if (b.notes !== undefined) update.notes = b.notes ? String(b.notes).slice(0, 4000) : null;
      if (b.assigned_to !== undefined) update.assigned_to = b.assigned_to ? +b.assigned_to : null;
      const { error } = await supabase.from('job_applications').update(update).eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    if (action === 'delete' && req.method === 'DELETE') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const { error } = await supabase.from('job_applications').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    if (action === 'cv' && req.method === 'GET') {
      const appId = +id;
      const { data, error } = await supabase
        .from('job_applications')
        .select('cv_original_name, cv_mime, cv_data')
        .eq('id', appId)
        .maybeSingle();
      if (error) return res.status(500).send(error.message);
      if (!data || !data.cv_data) return res.status(404).send('CV introuvable');
      let buf;
      if (typeof data.cv_data === 'string' && data.cv_data.startsWith('\\x')) buf = Buffer.from(data.cv_data.slice(2), 'hex');
      else if (typeof data.cv_data === 'string') buf = Buffer.from(data.cv_data, 'base64');
      else if (Buffer.isBuffer(data.cv_data)) buf = data.cv_data;
      else return res.status(500).send('Format CV inconnu');

      const filename = (data.cv_original_name || `cv-${appId}.pdf`).replace(/[\r\n"]/g, '_');
      res.set({
        'Content-Type': data.cv_mime || 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store, private',
      });
      return res.end(buf);
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('applications.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BLOG — commentaires (wp_post_id = ID REST article WordPress)
// ══════════════════════════════════════════════════════════════════════════════
const BLOG_COMMENT_HITS = new Map();
function blogCommentRateOk(ip, wpPostId, max = 5, windowMs = 3_600_000) {
  const k = `${ip}:${wpPostId}`;
  const now = Date.now();
  const arr = (BLOG_COMMENT_HITS.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  BLOG_COMMENT_HITS.set(k, arr);
  return true;
}

function sanitizeBlogCommentText(s, maxLen) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f]/g, ' ').replace(/<[^>]*>/g, '').trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen);
}

function isEmailish(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().slice(0, 254));
}

/** Lit (wp_post_id, bureau_article_id) depuis query/body — exactement un des deux est valide. */
function pickCommentTarget(src) {
  const wp = parseInt(String(src?.wp_post_id ?? ''), 10);
  const ba = parseInt(String(src?.bureau_article_id ?? ''), 10);
  const wpOk = Number.isFinite(wp) && wp > 0;
  const baOk = Number.isFinite(ba) && ba > 0;
  if (wpOk && !baOk) return { kind: 'wp', wp_post_id: wp, bureau_article_id: null, key: `wp:${wp}` };
  if (!wpOk && baOk) return { kind: 'bureau', wp_post_id: null, bureau_article_id: ba, key: `ba:${ba}` };
  return null;
}

app.get('/api/blog/comments', async (req, res) => {
  const target = pickCommentTarget(req.query);
  if (!target) return res.status(400).json({ error: 'wp_post_id OU bureau_article_id requis' });
  try {
    let q = supabase
      .from('afrilex_blog_comments')
      .select('id, author_name, body, created_at')
      .order('created_at', { ascending: true })
      .limit(500);
    q = target.kind === 'wp'
      ? q.eq('wp_post_id', target.wp_post_id)
      : q.eq('bureau_article_id', target.bureau_article_id);
    const { data, error } = await q;
    if (error) {
      console.error('GET /api/blog/comments', error);
      const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
      return res.status(missing ? 503 : 500).json({ error: missing ? 'Table afrilex_blog_comments absente.' : error.message, comments: [] });
    }
    return res.json({ comments: data ?? [] });
  } catch (e) {
    console.error('GET /api/blog/comments', e);
    return res.status(500).json({ error: e.message, comments: [] });
  }
});

app.post('/api/blog/comments', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
  const { author_name, author_email, body, website } = req.body || {};
  if (website != null && String(website).trim() !== '')
    return res.status(204).send();

  const target = pickCommentTarget(req.body);
  if (!target) return res.status(400).json({ error: 'Article invalide' });
  if (!blogCommentRateOk(ip, target.key))
    return res.status(429).json({ error: 'Trop de commentaires envoyés depuis cette connexion.' });

  const name = sanitizeBlogCommentText(author_name, 120);
  const email = sanitizeBlogCommentText(author_email, 254).toLowerCase();
  const text = sanitizeBlogCommentText(body, 4000);

  if (name.length < 2) return res.status(400).json({ error: 'Indiquez un nom (min. 2 caractères).' });
  if (!isEmailish(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (text.length < 3) return res.status(400).json({ error: 'Le message est trop court.' });

  const insertPayload = {
    wp_post_id: target.wp_post_id,
    bureau_article_id: target.bureau_article_id,
    author_name: name,
    author_email: email,
    body: text,
  };

  const { data, error } = await supabase
    .from('afrilex_blog_comments')
    .insert(insertPayload)
    .select('id, author_name, body, created_at')
    .single();

  if (error) {
    console.error('POST /api/blog/comments', error);
    const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
    return res.status(503).json({
      error: missing
        ? 'Créez la table afrilex_blog_comments dans Supabase (voir sql/supabase-setup.sql).'
        : "Impossible d'enregistrer le commentaire.",
    });
  }
  return res.status(201).json({ ok: true, comment: data });
});

// ══════════════════════════════════════════════════════════════════════════════
// JOB OFFERS — CRUD bureau + endpoint public
// ══════════════════════════════════════════════════════════════════════════════
function slugify(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `offre-${Date.now()}`;
}

async function ensureUniqueSlug(table, baseSlug, excludeId) {
  let slug = baseSlug;
  let n = 1;
  while (true) {
    let q = supabase.from(table).select('id').eq('slug', slug).limit(1);
    if (excludeId) q = q.neq('id', excludeId);
    const { data } = await q;
    if (!data || data.length === 0) return slug;
    n += 1;
    slug = `${baseSlug}-${n}`;
    if (n > 200) return `${baseSlug}-${Date.now()}`;
  }
}

function normalizeJobOfferPayload(b) {
  return {
    position_key:  typeof b.position_key === 'string' && b.position_key.trim() ? b.position_key.trim().slice(0, 64) : null,
    title_fr:      String(b.title_fr ?? '').trim().slice(0, 240),
    title_en:      b.title_en != null ? String(b.title_en).trim().slice(0, 240) || null : null,
    summary_fr:    String(b.summary_fr ?? '').trim().slice(0, 600),
    summary_en:    b.summary_en != null ? String(b.summary_en).trim().slice(0, 600) || null : null,
    meta_fr:       b.meta_fr != null ? String(b.meta_fr).trim().slice(0, 240) || null : null,
    meta_en:       b.meta_en != null ? String(b.meta_en).trim().slice(0, 240) || null : null,
    content_fr:    b.content_fr != null ? String(b.content_fr).slice(0, 60000) || null : null,
    content_en:    b.content_en != null ? String(b.content_en).slice(0, 60000) || null : null,
    contract_type: b.contract_type ? String(b.contract_type).trim().slice(0, 32) : 'cdd',
    location:      b.location != null ? String(b.location).trim().slice(0, 160) || null : null,
    is_new:        b.is_new == null ? true : !!b.is_new,
    is_published:  !!b.is_published,
    sort_order:    Number.isFinite(+b.sort_order) ? +b.sort_order : 0,
  };
}

app.all('/api/bureau/job_offers.php', async (req, res) => {
  try {
    if (!(await authGuard(req, res))) return;
    if (!permGuard(req, res, 'job_offers')) return;
    const { action, id } = req.query;

    if (action === 'list' && req.method === 'GET') {
      const u = await authGuard(req, res); if (!u) return;
      const { data, error } = await supabase
        .from('job_offers')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data ?? []);
    }

    if (action === 'create' && req.method === 'POST') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const payload = normalizeJobOfferPayload(req.body || {});
      if (!payload.title_fr) return res.status(400).json({ error: 'Le titre (FR) est requis' });
      if (!payload.summary_fr) return res.status(400).json({ error: 'Le résumé (FR) est requis' });
      const baseSlug = slugify(req.body?.slug || payload.title_fr);
      const slug = await ensureUniqueSlug('job_offers', baseSlug);
      const { data, error } = await supabase
        .from('job_offers')
        .insert({ ...payload, slug, created_by: u.id, published_at: payload.is_published ? new Date().toISOString() : null })
        .select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, offer: data });
    }

    if (action === 'update' && req.method === 'PUT') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const payload = normalizeJobOfferPayload(req.body || {});
      if (!payload.title_fr) return res.status(400).json({ error: 'Le titre (FR) est requis' });
      if (!payload.summary_fr) return res.status(400).json({ error: 'Le résumé (FR) est requis' });
      const offerId = +id;
      const { data: current } = await supabase.from('job_offers').select('slug, is_published, published_at').eq('id', offerId).maybeSingle();
      let slug = current?.slug;
      if (req.body?.slug && slugify(req.body.slug) !== current?.slug) {
        slug = await ensureUniqueSlug('job_offers', slugify(req.body.slug), offerId);
      }
      const newPublishedAt = payload.is_published
        ? (current?.published_at || new Date().toISOString())
        : null;
      const { data, error } = await supabase
        .from('job_offers')
        .update({ ...payload, slug, published_at: newPublishedAt })
        .eq('id', offerId)
        .select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, offer: data });
    }

    if (action === 'delete' && req.method === 'DELETE') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const { error } = await supabase.from('job_offers').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('job_offers.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/jobs/published', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('job_offers')
      .select('id, slug, position_key, title_fr, title_en, summary_fr, summary_en, meta_fr, meta_en, content_fr, content_en, contract_type, location, is_new, sort_order, published_at')
      .eq('is_published', true)
      .order('sort_order', { ascending: true })
      .order('published_at', { ascending: false });
    if (error) {
      const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
      return res.status(missing ? 503 : 500).json({ offers: [], error: missing ? 'Table job_offers absente — exécutez sql/supabase-setup.sql.' : error.message });
    }
    return res.json({ offers: data ?? [] });
  } catch (e) {
    return res.status(500).json({ offers: [], error: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BLOG ARTICLES — CRUD bureau + image upload (BYTEA) + endpoints publics
// ══════════════════════════════════════════════════════════════════════════════
function normalizeBlogArticlePayload(b) {
  return {
    title_fr:        String(b.title_fr ?? '').trim().slice(0, 240),
    title_en:        b.title_en != null ? String(b.title_en).trim().slice(0, 240) || null : null,
    excerpt_fr:      b.excerpt_fr != null ? String(b.excerpt_fr).trim().slice(0, 600) || null : null,
    excerpt_en:      b.excerpt_en != null ? String(b.excerpt_en).trim().slice(0, 600) || null : null,
    content_html_fr: String(b.content_html_fr ?? '').slice(0, 200000),
    content_html_en: b.content_html_en != null ? String(b.content_html_en).slice(0, 200000) || null : null,
    cover_image_url: b.cover_image_url != null ? String(b.cover_image_url).trim().slice(0, 600) || null : null,
    categories:      b.categories != null
      ? (Array.isArray(b.categories) ? b.categories : String(b.categories).split(','))
          .map((s) => String(s).trim()).filter(Boolean).slice(0, 10).join(',') || null
      : null,
    is_published:    !!b.is_published,
    author_name:     b.author_name != null ? String(b.author_name).trim().slice(0, 160) || null : null,
  };
}

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

app.all('/api/bureau/blog_articles.php', async (req, res) => {
  try {
    if (!(await authGuard(req, res))) return;
    if (!permGuard(req, res, 'blog')) return;
    const { action, id } = req.query;

    if (action === 'list' && req.method === 'GET') {
      const u = await authGuard(req, res); if (!u) return;
      const { data, error } = await supabase
        .from('blog_articles')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data ?? []);
    }

    if (action === 'get' && req.method === 'GET') {
      const u = await authGuard(req, res); if (!u) return;
      const { data, error } = await supabase
        .from('blog_articles')
        .select('*')
        .eq('id', +id)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Article introuvable' });
      const { data: images } = await supabase
        .from('blog_article_images')
        .select('id, filename, mime, size_bytes, created_at')
        .eq('article_id', +id)
        .order('created_at', { ascending: false });
      return res.json({ ...data, images: images ?? [] });
    }

    if (action === 'create' && req.method === 'POST') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const payload = normalizeBlogArticlePayload(req.body || {});
      if (!payload.title_fr) return res.status(400).json({ error: 'Le titre (FR) est requis' });
      if (!payload.content_html_fr.trim()) return res.status(400).json({ error: 'Le contenu (FR) est requis' });
      const baseSlug = slugify(req.body?.slug || payload.title_fr);
      const slug = await ensureUniqueSlug('blog_articles', baseSlug);
      if (!payload.author_name) payload.author_name = u.full_name || u.username;
      const { data, error } = await supabase
        .from('blog_articles')
        .insert({ ...payload, slug, created_by: u.id, published_at: payload.is_published ? new Date().toISOString() : null })
        .select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, article: data });
    }

    if (action === 'update' && req.method === 'PUT') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const payload = normalizeBlogArticlePayload(req.body || {});
      if (!payload.title_fr) return res.status(400).json({ error: 'Le titre (FR) est requis' });
      if (!payload.content_html_fr.trim()) return res.status(400).json({ error: 'Le contenu (FR) est requis' });
      const articleId = +id;
      const { data: current } = await supabase.from('blog_articles').select('slug, published_at').eq('id', articleId).maybeSingle();
      let slug = current?.slug;
      if (req.body?.slug && slugify(req.body.slug) !== current?.slug) {
        slug = await ensureUniqueSlug('blog_articles', slugify(req.body.slug), articleId);
      }
      const newPublishedAt = payload.is_published
        ? (current?.published_at || new Date().toISOString())
        : null;
      const { data, error } = await supabase
        .from('blog_articles')
        .update({ ...payload, slug, published_at: newPublishedAt })
        .eq('id', articleId)
        .select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, article: data });
    }

    if (action === 'delete' && req.method === 'DELETE') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const { error } = await supabase.from('blog_articles').delete().eq('id', +id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    if (action === 'upload_image' && req.method === 'POST') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const articleId = +id;
      const { filename, mime, data_base64, set_as_cover } = req.body || {};
      if (!ALLOWED_IMAGE_MIMES.has(String(mime || ''))) return res.status(400).json({ error: 'Type image non supporté (JPEG/PNG/WEBP/GIF).' });
      if (typeof data_base64 !== 'string' || data_base64.length < 64) return res.status(400).json({ error: 'Image absente ou invalide.' });
      const cleanB64 = data_base64.replace(/^data:[^,]+,/, '');
      const buf = Buffer.from(cleanB64, 'base64');
      if (buf.length === 0) return res.status(400).json({ error: 'Image vide.' });
      if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Image trop lourde (max 5 Mo).' });
      const dataHex = '\\x' + buf.toString('hex');
      const { data, error } = await supabase
        .from('blog_article_images')
        .insert({
          article_id: articleId || null,
          filename: filename ? String(filename).slice(0, 240) : null,
          mime: String(mime),
          data: dataHex,
          size_bytes: buf.length,
        })
        .select('id, filename, mime, size_bytes, created_at')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      const url = `/api/blog/images/${data.id}`;
      if (set_as_cover && articleId) {
        await supabase.from('blog_articles').update({ cover_image_url: url }).eq('id', articleId);
      }
      return res.json({ success: true, image: data, url });
    }

    if (action === 'delete_image' && req.method === 'DELETE') {
      const u = await authGuard(req, res, 'admin'); if (!u) return;
      const imageId = parseInt(String(req.query.image_id), 10);
      if (!Number.isFinite(imageId)) return res.status(400).json({ error: 'image_id requis' });
      const { error } = await supabase.from('blog_article_images').delete().eq('id', imageId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('blog_articles.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

const BLOG_ARTICLE_PUBLIC_COLUMNS =
  'id, slug, title_fr, title_en, excerpt_fr, excerpt_en, content_html_fr, content_html_en, cover_image_url, categories, author_name, published_at, created_at';

app.get('/api/blog/articles', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_articles')
      .select('id, slug, title_fr, title_en, excerpt_fr, excerpt_en, cover_image_url, categories, author_name, published_at, created_at')
      .eq('is_published', true)
      .order('published_at', { ascending: false });
    if (error) {
      const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
      return res.status(missing ? 503 : 500).json({ articles: [], error: missing ? 'Table blog_articles absente — exécutez sql/supabase-setup.sql.' : error.message });
    }
    return res.json({ articles: data ?? [] });
  } catch (e) {
    return res.status(500).json({ articles: [], error: String(e?.message || e) });
  }
});

app.get('/api/blog/articles/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug requis' });
  try {
    const { data, error } = await supabase
      .from('blog_articles')
      .select(BLOG_ARTICLE_PUBLIC_COLUMNS)
      .eq('slug', slug)
      .eq('is_published', true)
      .maybeSingle();
    if (error) {
      const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
      return res.status(missing ? 503 : 500).json({ error: missing ? 'Table blog_articles absente.' : error.message });
    }
    if (!data) return res.status(404).json({ error: 'Article introuvable' });
    return res.json({ article: data });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/blog/images/:id', async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id < 1) return res.status(400).send('id invalide');
  try {
    const { data, error } = await supabase
      .from('blog_article_images')
      .select('mime, data, size_bytes')
      .eq('id', id)
      .maybeSingle();
    if (error) return res.status(500).send(error.message);
    if (!data) return res.status(404).send('Image introuvable');
    let buf;
    if (typeof data.data === 'string' && data.data.startsWith('\\x')) {
      buf = Buffer.from(data.data.slice(2), 'hex');
    } else if (typeof data.data === 'string') {
      buf = Buffer.from(data.data, 'base64');
    } else if (Buffer.isBuffer(data.data)) {
      buf = data.data;
    } else {
      return res.status(500).send('Format image inconnu');
    }
    res.set({
      'Content-Type': data.mime || 'application/octet-stream',
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(buf);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MAILBOX LWS — comptes mail (super_admin) + lecture IMAP via imapflow
// Mots de passe IMAP chiffrés AES-256-GCM avec MAILBOX_ENCRYPTION_KEY (.env.local).
// ══════════════════════════════════════════════════════════════════════════════
function mailboxKey() {
  const raw = (process.env.MAILBOX_ENCRYPTION_KEY || '').trim();
  if (raw) {
    // Hex (64 caractères) → 32 bytes ; sinon dérive un SHA-256 sur la chaîne.
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
    return buf;
  }
  // Fallback : dérive depuis la service_role_key (recoverable depuis le serveur, pas optimal mais fonctionnel).
  return crypto.createHash('sha256').update('afrilex-mailbox|' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '')).digest();
}

function encryptSecret(plain) {
  if (typeof plain !== 'string' || !plain) throw new Error('Mot de passe vide');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mailboxKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptSecret(blob) {
  if (typeof blob !== 'string' || !blob.includes(':')) throw new Error('Format chiffré invalide');
  const [ivB64, tagB64, encB64] = blob.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', mailboxKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const MAILBOX_PUBLIC_COLUMNS =
  'id, label, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, active, created_at, updated_at';

function inferImapDefaults(email) {
  const domain = String(email || '').split('@')[1] || '';
  // LWS standard : mail.lws-hosting.com (pour les domaines hébergés chez LWS).
  // Adapter au besoin via le formulaire.
  return {
    imap_host: domain ? `mail.${domain}` : 'mail.lws-hosting.com',
    imap_port: 993,
    imap_secure: true,
    smtp_host: domain ? `mail.${domain}` : 'mail.lws-hosting.com',
    smtp_port: 465,
    smtp_secure: true,
  };
}

async function loadMailboxAccount(id, includeSecret = false) {
  const cols = includeSecret
    ? `${MAILBOX_PUBLIC_COLUMNS}, password_enc`
    : MAILBOX_PUBLIC_COLUMNS;
  const { data, error } = await supabase.from('mailbox_accounts').select(cols).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Détecte récursivement la présence d'une pièce jointe dans la bodyStructure IMAP. */
function hasAttachmentInStructure(part) {
  if (!part) return false;
  const disp = (part.disposition || '').toLowerCase();
  if (disp === 'attachment') return true;
  // Souvent : type="application/pdf" + disposition manquante, considéré comme PJ si pas inline
  if (!disp && part.type && /^(application|image|audio|video)\//i.test(part.type) && part.type !== 'application/pgp-signature') {
    // mais pas les images "related" (inline HTML)
    if (!part.id && !part.related) return true;
  }
  if (Array.isArray(part.childNodes)) {
    for (const c of part.childNodes) if (hasAttachmentInStructure(c)) return true;
  }
  return false;
}

/** Ouvre une connexion IMAP, exécute fn(client), ferme proprement (logout best-effort). */
async function withImapClient(account, fn, { timeoutMs = 25000 } = {}) {
  if (!ImapFlow) throw new Error('Module imapflow absent — npm install imapflow');
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: !!account.imap_secure,
    auth: { user: account.email, pass: decryptSecret(account.password_enc) },
    logger: false,
    socketTimeout: timeoutMs,
    greetingTimeout: 10000,
  });
  try {
    await client.connect();
    const r = await fn(client);
    return r;
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

app.all('/api/bureau/mailbox.php', async (req, res) => {
  try {
    const { action, id } = req.query;
    const u = await authGuard(req, res, 'super_admin'); if (!u) return;
    if (!permGuard(req, res, 'mailbox')) return;

    if (action === 'accounts' && req.method === 'GET') {
      const { data, error } = await supabase
        .from('mailbox_accounts')
        .select(MAILBOX_PUBLIC_COLUMNS)
        .order('label', { ascending: true });
      if (error) {
        const missing = /(does not exist|schema cache|Could not find the table)/i.test(error.message || '');
        return res.status(missing ? 503 : 500).json({
          error: missing ? 'Table mailbox_accounts absente — exécutez sql/supabase_perms_mailbox_addon.sql.' : error.message,
        });
      }
      return res.json({ accounts: data ?? [] });
    }

    if (action === 'add_account' && req.method === 'POST') {
      const { label, email, password, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure } = req.body || {};
      if (!label || !email || !password) return res.status(400).json({ error: 'label, email, password requis.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ error: 'Email invalide.' });
      const defaults = inferImapDefaults(email);
      const payload = {
        label: String(label).trim().slice(0, 160),
        email: String(email).trim().toLowerCase().slice(0, 254),
        imap_host: imap_host ? String(imap_host).trim().slice(0, 240) : defaults.imap_host,
        imap_port: Number.isFinite(+imap_port) ? +imap_port : defaults.imap_port,
        imap_secure: imap_secure == null ? true : !!imap_secure,
        smtp_host: smtp_host ? String(smtp_host).trim().slice(0, 240) : defaults.smtp_host,
        smtp_port: Number.isFinite(+smtp_port) ? +smtp_port : defaults.smtp_port,
        smtp_secure: smtp_secure == null ? true : !!smtp_secure,
        password_enc: encryptSecret(String(password)),
        active: true,
        created_by: u.id,
      };
      const { data, error } = await supabase.from('mailbox_accounts').insert(payload).select(MAILBOX_PUBLIC_COLUMNS).single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, account: data });
    }

    if (action === 'update_account' && req.method === 'PUT') {
      const accountId = +id;
      const body = req.body || {};
      const update = {};
      if (typeof body.label === 'string')       update.label       = body.label.trim().slice(0, 160);
      if (typeof body.email === 'string')       update.email       = body.email.trim().toLowerCase().slice(0, 254);
      if (typeof body.imap_host === 'string')   update.imap_host   = body.imap_host.trim().slice(0, 240);
      if (Number.isFinite(+body.imap_port))     update.imap_port   = +body.imap_port;
      if (body.imap_secure != null)             update.imap_secure = !!body.imap_secure;
      if (typeof body.smtp_host === 'string')   update.smtp_host   = body.smtp_host.trim().slice(0, 240) || null;
      if (Number.isFinite(+body.smtp_port))     update.smtp_port   = +body.smtp_port;
      if (body.smtp_secure != null)             update.smtp_secure = !!body.smtp_secure;
      if (body.active != null)                  update.active      = !!body.active;
      if (typeof body.password === 'string' && body.password.trim() !== '')
        update.password_enc = encryptSecret(body.password);
      const { data, error } = await supabase.from('mailbox_accounts').update(update).eq('id', accountId).select(MAILBOX_PUBLIC_COLUMNS).single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, account: data });
    }

    if (action === 'delete_account' && req.method === 'DELETE') {
      const accountId = +id;
      const { error } = await supabase.from('mailbox_accounts').delete().eq('id', accountId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    if (action === 'test_connection' && req.method === 'POST') {
      const accountId = +id;
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      try {
        const r = await withImapClient(account, async (client) => {
          const lock = await client.getMailboxLock('INBOX');
          try {
            const status = await client.status('INBOX', { messages: true, unseen: true });
            return { messages: status.messages ?? 0, unseen: status.unseen ?? 0 };
          } finally {
            lock.release();
          }
        });
        return res.json({ success: true, ...r });
      } catch (e) {
        return res.status(502).json({ success: false, error: String(e?.message || e) });
      }
    }

    if (action === 'inbox' && req.method === 'GET') {
      const accountId = +id;
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
      const folder = (req.query.folder && String(req.query.folder).trim()) || 'INBOX';
      try {
        const messages = await withImapClient(account, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const status = await client.status(folder, { messages: true, unseen: true });
            const total = status.messages ?? 0;
            if (total === 0) return { folder, total: 0, unseen: 0, messages: [] };
            const start = Math.max(1, total - limit + 1);
            const range = `${start}:${total}`;
            const list = [];
            for await (const m of client.fetch(range, { uid: true, envelope: true, internalDate: true, flags: true, size: true, bodyStructure: true })) {
              const env = m.envelope || {};
              const fromAddr = (env.from && env.from[0]) || {};
              const toAddrs = Array.isArray(env.to) ? env.to.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`.trim()).join(', ') : '';
              list.push({
                uid: m.uid,
                seq: m.seq,
                date: env.date || m.internalDate || null,
                subject: env.subject || '(sans objet)',
                from_name: fromAddr.name || '',
                from_address: fromAddr.address || '',
                to: toAddrs,
                size: m.size ?? 0,
                seen: Array.isArray(m.flags) ? m.flags.includes('\\Seen') : (m.flags && m.flags.has ? m.flags.has('\\Seen') : false),
                flagged: Array.isArray(m.flags) ? m.flags.includes('\\Flagged') : false,
                has_attachments: hasAttachmentInStructure(m.bodyStructure),
              });
            }
            list.sort((a, b) => (a.date < b.date ? 1 : -1));
            return { folder, total, unseen: status.unseen ?? 0, messages: list };
          } finally {
            lock.release();
          }
        }, { timeoutMs: 30000 });
        return res.json(messages);
      } catch (e) {
        return res.status(502).json({ error: String(e?.message || e) });
      }
    }

    if (action === 'attachment' && req.method === 'GET') {
      // Télécharge une pièce jointe d'un message — re-fetch + reparse pour récupérer le binaire.
      const accountId = +id;
      const uid = parseInt(String(req.query.uid ?? ''), 10);
      const idx = parseInt(String(req.query.idx ?? '0'), 10);
      if (!Number.isFinite(uid)) return res.status(400).send('uid requis');
      if (!simpleParser) return res.status(503).send('Module mailparser absent');
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).send('Compte introuvable');
      const folder = (req.query.folder && String(req.query.folder).trim()) || 'INBOX';
      try {
        const att = await withImapClient(account, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
            if (!m || !m.source) return null;
            const parsed = await simpleParser(m.source);
            const list = (parsed.attachments || []).filter((a) => !a.related);
            return list[idx] || null;
          } finally {
            lock.release();
          }
        }, { timeoutMs: 30000 });
        if (!att) return res.status(404).send('Pièce jointe introuvable');
        const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content || '');
        const filename = (att.filename || `piece-${idx + 1}`).replace(/[\r\n"]/g, '_');
        res.set({
          'Content-Type': att.contentType || 'application/octet-stream',
          'Content-Length': String(buf.length),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store, private',
        });
        return res.end(buf);
      } catch (e) {
        return res.status(502).send(String(e?.message || e));
      }
    }

    if (action === 'test_smtp' && req.method === 'POST') {
      if (!nodemailer) return res.status(503).json({ error: 'nodemailer absent' });
      const accountId = +id;
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      const results = [];
      let firstOk = null;
      let proxyOk = null;

      if (mailboxProxyConfigured()) {
        const start = Date.now();
        const proxy = await sendViaLwsProxy(account, {
          to: [account.email],
          subject: 'Test',
          text: '',
        }, null, { verifyOnly: true });
        const ms = Date.now() - start;
        if (proxy?.ok) {
          proxyOk = proxy.working || { via: 'lws_proxy' };
          const w = proxy.working || {};
          results.push({
            host: w.host || 'lws_proxy',
            port: w.port || 0,
            secure: !!w.secure,
            ok: true,
            ms,
            via: 'lws_proxy',
          });
          firstOk = results[0];
        } else {
          results.push({
            host: 'lws_proxy',
            port: 0,
            secure: false,
            ok: false,
            ms,
            via: 'lws_proxy',
            error: proxy?.error || 'Relais LWS échoué',
          });
        }
      }

      if (!firstOk) {
        for (const t of buildSmtpAttempts(account).slice(0, 3)) {
          const transporter = createSmtpTransporter(t.host, t.port, t.secure, account);
          const start = Date.now();
          try {
            await transporter.verify();
            const ms = Date.now() - start;
            const row = { host: t.host, port: t.port, secure: t.secure, ok: true, ms, via: 'direct' };
            results.push(row);
            if (!firstOk) firstOk = row;
          } catch (e) {
            results.push({
              host: t.host, port: t.port, secure: t.secure, ok: false,
              ms: Date.now() - start, via: 'direct',
              error: String(e?.message || e).slice(0, 220),
            });
          } finally {
            try { transporter.close(); } catch { /* ignore */ }
          }
          if (firstOk) break;
        }
      }

      const proxyHint = mailboxProxyConfigured()
        ? ''
        : ' Ajoutez MAILBOX_LWS_PROXY_URL + MAILBOX_PROXY_SECRET sur Render et uploadez dist/api/.';
      return res.json({
        success: !!firstOk,
        host: firstOk?.host || resolveSmtpHosts(account)[0],
        results,
        proxy_ok: !!proxyOk,
        mailbox_proxy: mailboxProxyConfigured(),
        recommendation: proxyOk
          ? `✅ Relais LWS OK (${proxyOk.host}:${proxyOk.port} ${proxyOk.secure ? 'SSL' : 'STARTTLS'}).`
          : firstOk
            ? `✅ SMTP direct ${firstOk.host}:${firstOk.port}.`
            : `❌ Échec envoi.${proxyHint}`,
      });
    }

    /** Mot de passe SMTP déchiffré côté Render (appel serveur-à-serveur depuis PHP LWS). */
    if (action === 'mail_password' && (req.method === 'GET' || req.method === 'POST')) {
      const accountId = +id;
      if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'id requis' });
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      if (!account.password_enc) {
        return res.status(400).json({ error: 'Aucun mot de passe enregistré — modifiez le compte et saisissez le mot de passe LWS.' });
      }
      try {
        const password = decryptSecret(account.password_enc);
        return res.json({ password });
      } catch (e) {
        return res.status(500).json({
          error: String(e?.message || e),
          hint: 'Dans Boîte mail → Modifier le compte → ressaisissez le mot de passe (identique à Roundcube) puis Enregistrer.',
        });
      }
    }

    if (action === 'send' && req.method === 'POST') {
      if (!nodemailer) return res.status(503).json({ error: 'Module nodemailer absent — npm install nodemailer.' });
      const accountId = +id;
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      const { to, cc, bcc, subject, text, html, in_reply_to } = req.body || {};
      const toList   = sanitizeRecipientList(to);
      const ccList   = sanitizeRecipientList(cc);
      const bccList  = sanitizeRecipientList(bcc);
      if (toList.length === 0) return res.status(400).json({ error: 'Au moins un destinataire (To) est requis.' });
      const subjStr = String(subject ?? '').trim().slice(0, 998);
      const textStr = typeof text === 'string' ? text : '';
      const htmlStr = typeof html === 'string' ? html : '';
      if (!textStr.trim() && !htmlStr.trim()) return res.status(400).json({ error: 'Corps du message vide.' });

      const info = await sendViaSmtpResilient(account, {
        to: toList, cc: ccList, bcc: bccList,
        subject: subjStr || '(sans objet)',
        text: textStr || undefined,
        html: htmlStr || undefined,
        inReplyTo: in_reply_to || undefined,
      });
      if (!info.ok) {
        return res.status(502).json({
          success: false,
          error: info.error,
          attempted: info.attempted,
          via: info.via || (mailboxProxyConfigured() ? 'lws_proxy' : 'direct'),
          mailbox_proxy: mailboxProxyConfigured(),
          hint: info.hint || (!mailboxProxyConfigured()
            ? 'Déployez dist/api/ sur LWS et MAILBOX_* sur Render.'
            : 'Re-uploadez dist/api/mailbox-relay.config.php et vérifiez le secret Render.'),
        });
      }
      // Best-effort : copie dans le dossier "Sent" — fire-and-forget, n'attend PAS la réponse.
      appendToSentFolderInBackground(account, info.raw).catch(() => {});
      return res.json({
        success: true,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
      });
    }

    if (action === 'message' && req.method === 'GET') {
      const accountId = +id;
      const uid = parseInt(String(req.query.uid ?? ''), 10);
      if (!Number.isFinite(uid)) return res.status(400).json({ error: 'uid requis' });
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      const folder = (req.query.folder && String(req.query.folder).trim()) || 'INBOX';
      try {
        const msg = await withImapClient(account, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const m = await client.fetchOne(String(uid), { uid: true, envelope: true, source: true, internalDate: true, flags: true, size: true }, { uid: true });
            if (!m) return null;
            const env = m.envelope || {};
            const fromAddr = (env.from && env.from[0]) || {};

            // Parse complet via mailparser (gère multipart imbriqué, quoted-printable, charsets,
            // pièces jointes, images inline, etc.). Fallback sur parser maison si module absent.
            let parsed = null;
            if (simpleParser && m.source) {
              try {
                parsed = await simpleParser(m.source, { skipImageLinks: false, skipHtmlToText: false });
              } catch (pe) {
                console.warn('mailparser failed, fallback:', pe?.message);
              }
            }
            const sourceStr = m.source ? m.source.toString('utf8') : '';
            const fallback = parsed ? null : quickParseMime(sourceStr);

            const text = parsed?.text ?? fallback?.text ?? '';
            const html = parsed?.html ?? fallback?.html ?? '';
            const attachments = (parsed?.attachments ?? [])
              .filter((a) => !a.related)                                // exclure les images inline (dans le HTML)
              .map((a) => ({
                filename: a.filename || `piece-${a.contentId || 'jointe'}`,
                contentType: a.contentType || 'application/octet-stream',
                size: a.size ?? 0,
              }));

            return {
              uid: m.uid,
              message_id: env.messageId || null,
              date: env.date || m.internalDate || null,
              subject: env.subject || '(sans objet)',
              from_name: fromAddr.name || (parsed?.from?.value?.[0]?.name ?? ''),
              from_address: fromAddr.address || (parsed?.from?.value?.[0]?.address ?? ''),
              to: Array.isArray(env.to) ? env.to.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`.trim()).join(', ') : (parsed?.to?.text ?? ''),
              to_addresses: Array.isArray(env.to) ? env.to.map((a) => a.address).filter(Boolean) : (parsed?.to?.value?.map((a) => a.address).filter(Boolean) ?? []),
              cc: Array.isArray(env.cc) ? env.cc.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`.trim()).join(', ') : (parsed?.cc?.text ?? ''),
              cc_addresses: Array.isArray(env.cc) ? env.cc.map((a) => a.address).filter(Boolean) : (parsed?.cc?.value?.map((a) => a.address).filter(Boolean) ?? []),
              size: m.size ?? 0,
              text,
              html,
              attachments,
            };
          } finally {
            lock.release();
          }
        });
        if (!msg) return res.status(404).json({ error: 'Message introuvable' });
        return res.json(msg);
      } catch (e) {
        return res.status(502).json({ error: String(e?.message || e) });
      }
    }

    if (action === 'delete_message' && (req.method === 'POST' || req.method === 'DELETE')) {
      const accountId = +id;
      const uid = parseInt(String(req.query.uid ?? ''), 10);
      const folder = (req.query.folder && String(req.query.folder).trim()) || 'INBOX';
      const permanent = String(req.query.permanent ?? '').toLowerCase() === 'true';
      if (!Number.isFinite(uid)) return res.status(400).json({ error: 'uid requis' });
      const account = await loadMailboxAccount(accountId, true);
      if (!account) return res.status(404).json({ error: 'Compte introuvable' });
      try {
        const result = await withImapClient(account, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            // Recherche du dossier Corbeille (Trash) parmi les boîtes du compte
            let trashPath = null;
            if (!permanent) {
              try {
                const list = await client.list();
                const candidates = ['\\Trash', '\\Junk'];
                const found = list.find((b) =>
                  (Array.isArray(b.specialUse) ? b.specialUse.some((s) => candidates.includes(s)) : candidates.includes(b.specialUse))
                  || /^(trash|corbeille|deleted|deleted\s*items?)$/i.test(b.path)
                  || /^(trash|corbeille|deleted|deleted\s*items?)$/i.test(b.name),
                );
                if (found) trashPath = found.path;
              } catch { /* ignore */ }
            }

            if (trashPath && trashPath !== folder) {
              // Déplacement vers la corbeille (préférable, réversible)
              try {
                const moved = await client.messageMove(String(uid), trashPath, { uid: true });
                return { success: true, action: 'moved_to_trash', trash: trashPath, moved };
              } catch (moveErr) {
                console.warn('messageMove fallback to flag+expunge:', moveErr?.message);
              }
            }
            // Fallback : flag \Deleted + expunge (suppression définitive)
            await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
            try { await client.messageDelete(String(uid), { uid: true }); } catch { /* expunge */ }
            return { success: true, action: 'expunged' };
          } finally {
            lock.release();
          }
        }, { timeoutMs: 30000 });
        return res.json(result);
      } catch (e) {
        return res.status(502).json({ error: String(e?.message || e) });
      }
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('mailbox.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/** Hôtes SMTP à essayer (LWS : mail.domaine, parfois smtp.domaine ou lwspanel). */
function resolveSmtpHosts(account) {
  const email = String(account.email || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  const seen = new Set();
  const out = [];
  const push = (h) => {
    const host = String(h || '').trim().toLowerCase();
    if (!host || seen.has(host)) return;
    seen.add(host);
    out.push(host);
  };
  push(account.smtp_host);
  push(account.imap_host);
  if (domain) {
    push(`mail.${domain}`);
    push(`smtp.${domain}`);
  }
  push('mail.lws-hosting.com');
  return out;
}

/** Matrice host × port pour envoi / test SMTP (587 STARTTLS souvent le plus fiable). */
function buildSmtpAttempts(account) {
  const declaredPort = account.smtp_port ?? 465;
  const declaredSecure = account.smtp_secure ?? true;
  const portModes = [];
  const addPort = (port, secure) => {
    const key = `${port}:${secure ? 1 : 0}`;
    if (portModes.some((p) => `${p.port}:${p.secure ? 1 : 0}` === key)) return;
    portModes.push({ port, secure });
  };
  addPort(declaredPort, declaredSecure);
  if (declaredPort !== 587) addPort(587, false);
  if (declaredPort !== 465) addPort(465, true);
  if (![25, 465, 587].includes(declaredPort)) addPort(25, false);

  const hosts = resolveSmtpHosts(account);
  const attempts = [];
  const seen = new Set();
  for (const host of hosts) {
    for (const pm of portModes) {
      const key = `${host}:${pm.port}:${pm.secure ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push({ host, port: pm.port, secure: pm.secure });
    }
  }
  return attempts;
}

function isSmtpRetriableError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return /timeout|timed out|econnrefused|enetunreach|ehostunreach|epipe|esock|etimedout|connection closed|socket|tls|ssl|starttls|wrong version|421|454|connection reset/i.test(m);
}

function isSmtpAuthError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return /535|534|authentication|invalid login|auth failed|credentials|password/i.test(m);
}

function createSmtpTransporter(host, port, secure, account) {
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: account.email, pass: decryptSecret(account.password_enc) },
    connectionTimeout: 22000,
    greetingTimeout: 12000,
    socketTimeout: 45000,
    family: 4,
    tls: { servername: host, rejectUnauthorized: false },
  });
}

/**
 * Relais d'envoi sur l'hébergement LWS (PHP) — contourne le blocage SMTP sortant des PaaS (Render free).
 * Variables : MAILBOX_LWS_PROXY_URL + MAILBOX_PROXY_SECRET (même secret dans api/config.php).
 */
function mailboxProxyConfigured() {
  return !!(process.env.MAILBOX_LWS_PROXY_URL || '').trim() && !!(process.env.MAILBOX_PROXY_SECRET || '').trim();
}

async function sendViaLwsProxy(account, mail, raw, { verifyOnly = false } = {}) {
  const url = (process.env.MAILBOX_LWS_PROXY_URL || '').trim();
  const secret = (process.env.MAILBOX_PROXY_SECRET || '').trim();
  if (!url || !secret) return null;

  const hosts = resolveSmtpHosts(account);
  const attempts = buildSmtpAttempts(account);
  const body = {
    verify_only: verifyOnly,
    smtp_host: account.smtp_host || account.imap_host || null,
    smtp_port: account.smtp_port ?? 465,
    smtp_secure: account.smtp_secure ?? true,
    hosts,
    attempts: attempts.slice(0, 8),
    user: account.email,
    pass: decryptSecret(account.password_enc),
    from: account.email,
    from_name: account.label || account.email,
    to: mail.to,
    cc: mail.cc?.length ? mail.cc : undefined,
    bcc: mail.bcc?.length ? mail.bcc : undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    in_reply_to: mail.inReplyTo,
    raw_b64: raw ? raw.toString('base64') : undefined,
  };

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 90000) : null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mailbox-Proxy-Secret': secret,
      },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text?.slice(0, 300) }; }
    if (!r.ok) {
      return {
        ok: false,
        error: data.error || `Relais LWS HTTP ${r.status}`,
        attempted: data.attempted || [{ via: 'lws_proxy', ok: false, error: text?.slice(0, 200) }],
        via: 'lws_proxy',
      };
    }
    if (!data.success) {
      return {
        ok: false,
        error: data.error || 'Relais LWS : échec',
        attempted: data.attempted,
        via: 'lws_proxy',
      };
    }
    return {
      ok: true,
      messageId: data.messageId,
      accepted: data.accepted ?? [],
      rejected: data.rejected ?? [],
      raw: data.raw_b64 ? Buffer.from(data.raw_b64, 'base64') : raw,
      attempted: data.attempted ?? [{ via: 'lws_proxy', ok: true }],
      via: 'lws_proxy',
      working: data.working,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Relais LWS injoignable : ${String(e?.message || e)}`,
      attempted: [{ via: 'lws_proxy', ok: false }],
      via: 'lws_proxy',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function persistWorkingSmtpConfig(accountId, working) {
  if (!working?.host || !working?.port) return;
  try {
    await supabase.from('mailbox_accounts').update({
      smtp_host: working.host,
      smtp_port: working.port,
      smtp_secure: !!working.secure,
      updated_at: new Date().toISOString(),
    }).eq('id', accountId);
  } catch { /* best-effort */ }
}

/**
 * Construit le raw RFC822 via MailComposer (nodemailer interne) pour pouvoir le
 * réutiliser dans IMAP APPEND vers le dossier Envoyés.
 */
async function buildRawMessage(mail) {
  if (!nodemailer) throw new Error('nodemailer absent');
  const MailComposer = require('nodemailer/lib/mail-composer');
  const composer = new MailComposer(mail);
  return await new Promise((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

/**
 * Envoi mail : relais LWS (PHP) en priorité sur Render, sinon SMTP direct (dev / VPS).
 */
async function sendViaSmtpResilient(account, mail) {
  const attempts = [];
  const messageId = `<${crypto.randomBytes(12).toString('hex')}@${(account.email.split('@')[1] || 'local')}>`;
  const composed = {
    from: { name: account.label || account.email, address: account.email },
    to: mail.to,
    cc: mail.cc?.length ? mail.cc : undefined,
    bcc: mail.bcc?.length ? mail.bcc : undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo,
    references: mail.inReplyTo ? [mail.inReplyTo] : undefined,
    messageId,
  };
  let raw = null;
  try { raw = await buildRawMessage(composed); } catch { /* sendMail composera si besoin */ }

  // Render bloque SMTP sortant → relais LWS d'abord (évite 2+ min de timeouts 465/587/25).
  if (mailboxProxyConfigured()) {
    const proxy = await sendViaLwsProxy(account, mail, raw);
    if (proxy?.ok) {
      if (account.id && proxy.working) await persistWorkingSmtpConfig(account.id, proxy.working);
      return proxy;
    }
    if (proxy) {
      return {
        ok: false,
        via: 'lws_proxy',
        error: proxy.error || 'Échec relais LWS',
        attempted: proxy.attempted ?? [{ via: 'lws_proxy', ok: false, error: proxy.error }],
        hint: 'Vérifiez dist/api/mailbox-relay.config.php sur LWS et MAILBOX_PROXY_SECRET sur Render (identiques).',
      };
    }
  }

  let lastErr = null;
  let authFailed = false;
  const directTries = buildSmtpAttempts(account).slice(0, 4);
  for (const t of directTries) {
    const transporter = nodemailer.createTransport({
      host: t.host,
      port: t.port,
      secure: t.secure,
      requireTLS: !t.secure,
      auth: { user: account.email, pass: decryptSecret(account.password_enc) },
      connectionTimeout: 8000,
      greetingTimeout: 6000,
      socketTimeout: 12000,
      family: 4,
      tls: { servername: t.host, rejectUnauthorized: false },
    });
    try {
      const info = await transporter.sendMail(composed);
      try { transporter.close(); } catch { /* ignore */ }
      attempts.push({ ...t, ok: true });
      if (account.id) await persistWorkingSmtpConfig(account.id, t);
      return {
        ok: true,
        messageId: info.messageId || messageId,
        accepted: info.accepted ?? [],
        rejected: info.rejected ?? [],
        raw: info.message || raw,
        attempted: attempts,
        via: 'direct',
        working: t,
      };
    } catch (e) {
      lastErr = e;
      attempts.push({ ...t, ok: false, error: String(e?.message || e).slice(0, 220) });
      try { transporter.close(); } catch { /* ignore */ }
      if (isSmtpAuthError(e)) { authFailed = true; break; }
      if (!isSmtpRetriableError(e)) break;
    }
  }

  if (!authFailed && !mailboxProxyConfigured()) {
    const proxy = await sendViaLwsProxy(account, mail, raw);
    if (proxy?.ok) {
      if (account.id && proxy.working) await persistWorkingSmtpConfig(account.id, proxy.working);
      return proxy;
    }
    if (proxy?.attempted) attempts.push(...proxy.attempted);
    if (proxy?.error) lastErr = new Error(proxy.error);
  }

  const hint = mailboxProxyConfigured()
    ? ''
    : ' Configurez MAILBOX_LWS_PROXY_URL + MAILBOX_PROXY_SECRET sur Render et uploadez dist/api/ (voir MAILBOX-RELAY.md).';
  return {
    ok: false,
    error: String(lastErr?.message || lastErr || 'Échec envoi SMTP') + hint,
    attempted: attempts,
    via: mailboxProxyConfigured() ? 'lws_proxy' : 'direct',
  };
}

/**
 * Notification mail au client : envoie un mail simple via le premier mailbox_account actif.
 * Asynchrone fire-and-forget — n'attend PAS la réponse SMTP, ne bloque jamais.
 */
async function notifyClientByEmail({ to, subject, text, html }) {
  if (!nodemailer || !to) return;
  try {
    const { data: account } = await supabase
      .from('mailbox_accounts')
      .select('label, email, password_enc, smtp_host, smtp_port, smtp_secure, imap_host')
      .eq('active', true)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!account) return; // Pas de compte mail configuré → silencieux
    const result = await sendViaSmtpResilient(account, {
      to: [to],
      subject: subject || '(Afrilex Conseil)',
      text,
      html,
    });
    if (!result.ok) console.warn('notifyClientByEmail KO:', result.error?.slice(0, 120));
  } catch (e) {
    console.warn('notifyClientByEmail exception:', e?.message);
  }
}

/** Best-effort copie du raw RFC822 dans le dossier Envoyés. Silencieux si absent / non supporté. */
async function appendToSentFolderInBackground(account, raw) {
  if (!raw || !ImapFlow) return;
  try {
    await withImapClient(account, async (client) => {
      const candidates = ['Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages', 'Envoy\u00e9s', 'INBOX.Envoy\u00e9s', 'INBOX.Sent Items'];
      for (const name of candidates) {
        try {
          const opened = await client.mailboxOpen(name).catch(() => null);
          if (opened) {
            await client.append(name, raw, ['\\Seen']).catch(() => {});
            await client.mailboxClose().catch(() => {});
            return;
          }
        } catch { /* try next */ }
      }
    }, { timeoutMs: 12000 });
  } catch { /* silencieux */ }
}

/**
 * Normalise une liste de destinataires : accepte tableau ou CSV/saut-de-ligne, valide format email basique.
 * Retire les doublons et limite à 50 destinataires par champ.
 */
function sanitizeRecipientList(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input.join(',') : String(input);
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const t = part.trim().replace(/^[<\s]+|[>\s]+$/g, '');
    if (!t || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Parse MIME ultra-léger : extrait text/plain et text/html du brut RFC 822.
 * Suffisant pour 90 % des emails LWS courants ; pour parsing complet (pièces jointes, encodings exotiques),
 * on remplacera par mailparser plus tard.
 */
function quickParseMime(source) {
  if (!source) return { text: '', html: '' };
  const headerEnd = source.indexOf('\r\n\r\n');
  const headers = headerEnd === -1 ? source : source.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : source.slice(headerEnd + 4);
  const ctMatch = /^content-type:\s*([^;\r\n]+)(?:;\s*boundary="?([^";\r\n]+)"?)?/im.exec(headers);
  const cteMatch = /^content-transfer-encoding:\s*([^\r\n]+)/im.exec(headers);
  const cte = (cteMatch?.[1] || '7bit').toLowerCase().trim();
  const ct = (ctMatch?.[1] || 'text/plain').toLowerCase().trim();
  const boundary = ctMatch?.[2];

  function decode(part, encoding) {
    if (encoding === 'base64') {
      try { return Buffer.from(part.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return part; }
    }
    if (encoding === 'quoted-printable') {
      try {
        return part
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      } catch { return part; }
    }
    return part;
  }

  if (!boundary) {
    if (ct.startsWith('text/html'))  return { text: '', html: decode(body, cte) };
    return { text: decode(body, cte), html: '' };
  }

  const sep = `--${boundary}`;
  const parts = body.split(sep).slice(1, -1);
  let text = '';
  let html = '';
  for (const raw of parts) {
    const rPart = raw.replace(/^\r?\n/, '');
    const pHeaderEnd = rPart.indexOf('\r\n\r\n');
    if (pHeaderEnd === -1) continue;
    const pHeaders = rPart.slice(0, pHeaderEnd);
    const pBody = rPart.slice(pHeaderEnd + 4);
    const pCt = (/^content-type:\s*([^;\r\n]+)/im.exec(pHeaders)?.[1] || '').toLowerCase().trim();
    const pCte = (/^content-transfer-encoding:\s*([^\r\n]+)/im.exec(pHeaders)?.[1] || '7bit').toLowerCase().trim();
    if (pCt.startsWith('text/plain') && !text) text = decode(pBody, pCte);
    else if (pCt.startsWith('text/html') && !html) html = decode(pBody, pCte);
  }
  return { text, html };
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENTS — Liste minimale des comptes clients (pour les sélecteurs bureau)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/bureau/clients.php', async (req, res) => {
  try {
    if (!(await authGuard(req, res))) return;
    if (!permGuard(req, res, 'clients')) return;
    const { action } = req.query;
    if (action === 'list_all') {
      const { data, error } = await supabase
        .from('clients')
        .select('id, name, email, company, phone, active, created_at')
        .order('name', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data ?? []);
    }
    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CALENDRIER GLOBAL — tous les events de tous les dossiers (bureau)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/bureau/calendar.php', async (req, res) => {
  try {
    const u = await authGuard(req, res); if (!u) return;
    if (!userHasPermission(u, 'projects') && !userHasPermission(u, 'cases')) {
      return res.status(403).json({ error: 'Permission requise' });
    }
    const from = req.query.from ? String(req.query.from) : new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
    const to   = req.query.to   ? String(req.query.to)   : new Date(Date.now() + 60 * 86400e3).toISOString().slice(0, 10);
    // Essai 1 : requête complète avec join projets (suppose addon SQL appliqué)
    // NB: case_events n'a PAS de colonne `status` (seulement completed_at + outcome)
    let { data: events, error } = await supabase
      .from('case_events')
      .select('id, project_id, type, title, scheduled_at, duration_minutes, location, visible_to_client, completed_at, project:projects!project_id(id, name, case_number, status, priority)')
      .gte('scheduled_at', from + 'T00:00:00')
      .lte('scheduled_at', to + 'T23:59:59')
      .order('scheduled_at');
    // Fallback : pas de colonne case_number sur projects → on retire le join enrichi
    if (error && /case_number|does not exist|schema cache/i.test(error.message || '')) {
      const fb = await supabase
        .from('case_events')
        .select('id, project_id, type, title, scheduled_at, duration_minutes, location, visible_to_client, completed_at, project:projects!project_id(id, name, status, priority)')
        .gte('scheduled_at', from + 'T00:00:00')
        .lte('scheduled_at', to + 'T23:59:59')
        .order('scheduled_at');
      events = fb.data; error = fb.error;
    }
    if (error) {
      const missing = /(relation .* does not exist|Could not find the table|schema cache)/i.test(error.message || '');
      return res.status(missing ? 200 : 500).json({
        from, to, events: [],
        warning: missing
          ? "Table 'case_events' absente. Exécutez sql/supabase_cases_addon.sql pour activer le calendrier."
          : error.message,
      });
    }
    return res.json({
      from, to,
      events: (events ?? []).map((e) => ({
        id: e.id, project_id: e.project_id, type: e.type, title: e.title,
        scheduled_at: e.scheduled_at, duration_minutes: e.duration_minutes,
        location: e.location,
        status: e.completed_at ? 'completed' : 'planned',  // statut dérivé de completed_at
        visible_to_client: e.visible_to_client,
        case_name: e.project?.name ?? null,
        case_number: e.project?.case_number ?? null,
        case_priority: e.project?.priority ?? null,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FINANCE — vue d'ensemble cabinet (factures, encaissements, prévisions)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/bureau/finance.php', async (req, res) => {
  try {
    const u = await authGuard(req, res); if (!u) return;
    if (!userHasPermission(u, 'accounting') && !userHasPermission(u, 'cases')) {
      return res.status(403).json({ error: 'Permission requise' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + '01';
    const m1Start = (() => { const d = new Date(monthStart); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); })();
    const m2Start = (() => { const d = new Date(monthStart); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 10); })();
    const m3Start = (() => { const d = new Date(monthStart); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); })();

    let invoicesRes = await supabase.from('case_invoices')
      .select('id, project_id, invoice_number, title, amount, paid_amount, currency, status, due_date, sent_at, created_at, project:projects!project_id(name, case_number)')
      .order('created_at', { ascending: false });
    if (invoicesRes.error && /case_number|does not exist|schema cache/i.test(invoicesRes.error.message || '')) {
      invoicesRes = await supabase.from('case_invoices')
        .select('id, project_id, invoice_number, title, amount, paid_amount, currency, status, due_date, sent_at, created_at, project:projects!project_id(name)')
        .order('created_at', { ascending: false });
    }
    if (invoicesRes.error) {
      const missing = /(relation .* does not exist|Could not find the table|schema cache)/i.test(invoicesRes.error.message || '');
      if (missing) {
        return res.json({
          kpis: { total_invoiced: 0, total_collected: 0, total_outstanding: 0, overdue_count: 0, overdue_amount: 0 },
          overdue: [], trend: [], top_to_collect: [], forecast: [],
          warning: "Tables 'case_invoices' / 'case_payments' absentes. Exécutez sql/supabase_phase2_addon.sql pour activer le tableau financier.",
        });
      }
      return res.status(500).json({ error: invoicesRes.error.message });
    }
    const paymentsRes = await supabase.from('case_payments').select('id, invoice_id, amount, paid_at').order('paid_at', { ascending: false });
    const invoices = invoicesRes.data;
    const payments = paymentsRes.error ? [] : paymentsRes.data;

    const isOverdue = (inv) => inv.due_date && inv.due_date < today && inv.status !== 'payee' && inv.status !== 'annulee';
    const overdueList = (invoices ?? []).filter(isOverdue).map((i) => ({
      id: i.id, project_id: i.project_id, invoice_number: i.invoice_number, title: i.title,
      amount: Number(i.amount), paid_amount: Number(i.paid_amount || 0),
      remaining: Number(i.amount) - Number(i.paid_amount || 0),
      currency: i.currency, due_date: i.due_date, status: i.status,
      case_name: i.project?.name ?? null, case_number: i.project?.case_number ?? null,
      days_overdue: Math.floor((new Date(today) - new Date(i.due_date)) / 86400e3),
    }));

    const totalInvoiced = (invoices ?? []).filter((i) => i.status !== 'brouillon' && i.status !== 'annulee').reduce((s, i) => s + Number(i.amount), 0);
    const totalCollected = (invoices ?? []).reduce((s, i) => s + Number(i.paid_amount || 0), 0);
    const totalOutstanding = overdueList.reduce((s, i) => s + i.remaining, 0) + (invoices ?? []).filter((i) => !isOverdue(i) && i.status !== 'payee' && i.status !== 'brouillon' && i.status !== 'annulee').reduce((s, i) => s + (Number(i.amount) - Number(i.paid_amount || 0)), 0);

    const monthlyCollected = (label, start, end) => ({
      label,
      amount: (payments ?? []).filter((p) => p.paid_at && p.paid_at >= start && p.paid_at < end).reduce((s, p) => s + Number(p.amount), 0),
    });
    const nextMonth = (d) => { const x = new Date(d); x.setMonth(x.getMonth() + 1); return x.toISOString().slice(0, 10); };

    const trend = [
      monthlyCollected(m3Start.slice(0, 7), m3Start, m2Start),
      monthlyCollected(m2Start.slice(0, 7), m2Start, m1Start),
      monthlyCollected(m1Start.slice(0, 7), m1Start, monthStart),
      monthlyCollected(monthStart.slice(0, 7), monthStart, nextMonth(monthStart)),
    ];

    const byProject = {};
    for (const o of overdueList) {
      const k = String(o.project_id);
      if (!byProject[k]) byProject[k] = { project_id: o.project_id, case_name: o.case_name, case_number: o.case_number, total: 0, count: 0 };
      byProject[k].total += o.remaining; byProject[k].count += 1;
    }
    const topToCollect = Object.values(byProject).sort((a, b) => b.total - a.total).slice(0, 10);

    const forecast = {};
    for (const inv of invoices ?? []) {
      if (!inv.due_date || inv.status === 'payee' || inv.status === 'annulee' || inv.status === 'brouillon') continue;
      if (isOverdue(inv)) continue;
      const month = inv.due_date.slice(0, 7);
      if (!forecast[month]) forecast[month] = 0;
      forecast[month] += Number(inv.amount) - Number(inv.paid_amount || 0);
    }
    const forecastList = Object.entries(forecast).map(([month, amount]) => ({ month, amount })).sort((a, b) => a.month.localeCompare(b.month)).slice(0, 6);

    return res.json({
      kpis: {
        total_invoiced: totalInvoiced,
        total_collected: totalCollected,
        total_outstanding: totalOutstanding,
        overdue_count: overdueList.length,
        overdue_amount: overdueList.reduce((s, o) => s + o.remaining, 0),
      },
      overdue: overdueList,
      trend,
      top_to_collect: topToCollect,
      forecast: forecastList,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CASES — Vue client (lecture seule des dossiers du client connecté)
// Filtre tout par visible_to_client / confidential pour ne JAMAIS exposer
// d'info confidentielle équipe.
// ══════════════════════════════════════════════════════════════════════════════
async function clientHasAccessToCase(clientId, projectId) {
  const { data } = await supabase
    .from('case_clients')
    .select('project_id')
    .eq('client_id', clientId)
    .eq('project_id', projectId)
    .maybeSingle();
  return !!data;
}

app.all('/api/client/cases.php', async (req, res) => {
  try {
    const c = await clientGuard(req, res); if (!c) return;
    const { action, id } = req.query;

    // ── Liste des dossiers du client (multi) ───────────────────────────────────
    if (action === 'list' && req.method === 'GET') {
      const { data: links } = await supabase
        .from('case_clients')
        .select('role, added_at, project:projects(id, name, status, priority, current_phase, practice_area, case_number, next_action, next_action_date, deadline, progress, created_at, updated_at, assigned_user:users!assigned_to(full_name))')
        .eq('client_id', c.id);
      const cases = (links ?? [])
        .filter((l) => l.project) // au cas où orphan
        .map((l) => ({ ...l.project, role_in_case: l.role, added_at: l.added_at, agent_name: l.project.assigned_user?.full_name ?? null, assigned_user: undefined }));
      // Compatibilité legacy : si clients.project_id existe et qu'aucun lien M2M, l'ajouter au vol
      if (cases.length === 0 && c.project_id) {
        const { data: legacy } = await supabase
          .from('projects')
          .select('id, name, status, priority, current_phase, practice_area, case_number, next_action, next_action_date, deadline, progress, created_at, updated_at, assigned_user:users!assigned_to(full_name)')
          .eq('id', c.project_id).maybeSingle();
        if (legacy) cases.push({ ...legacy, role_in_case: 'principal', agent_name: legacy.assigned_user?.full_name ?? null, assigned_user: undefined });
      }
      cases.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return res.json({ cases });
    }

    // ── Vue détaillée d'UN dossier ────────────────────────────────────────────
    if (action === 'get' && req.method === 'GET') {
      const projectId = +id;
      const allowed = await clientHasAccessToCase(c.id, projectId) || (c.project_id === projectId);
      if (!allowed) return res.status(403).json({ error: 'Accès refusé' });

      const [project, milestones, events, documents] = await Promise.all([
        supabase.from('projects').select('id, name, description, status, priority, current_phase, practice_area, case_number, next_action, next_action_date, deadline, progress, created_at, updated_at, assigned_user:users!assigned_to(full_name)').eq('id', projectId).maybeSingle(),
        supabase.from('case_milestones').select('id, title, description, due_date, completed_at, status, order_index, created_at').eq('project_id', projectId).eq('visible_to_client', true).order('order_index').order('created_at'),
        supabase.from('case_events').select('id, type, title, location, scheduled_at, duration_minutes, notes_client_facing, completed_at, outcome, created_at').eq('project_id', projectId).eq('visible_to_client', true).order('scheduled_at'),
        supabase.from('case_documents').select('id, title, kind, description, filename, mime, size_bytes, uploaded_by_user_id, uploaded_by_client_id, created_at, uploader_user:users!uploaded_by_user_id(full_name)').eq('project_id', projectId).eq('visible_to_client', true).eq('confidential', false).order('created_at', { ascending: false }),
      ]);
      if (!project.data) return res.status(404).json({ error: 'Dossier introuvable' });

      return res.json({
        project: { ...project.data, agent_name: project.data.assigned_user?.full_name ?? null, assigned_user: undefined },
        milestones: milestones.data ?? [],
        events:     events.data ?? [],
        documents: (documents.data ?? []).map((d) => ({
          ...d,
          uploader_user: undefined,
          uploaded_by_name: d.uploader_user?.full_name ?? null,
          uploaded_by_kind: d.uploaded_by_user_id ? 'cabinet' : (d.uploaded_by_client_id ? 'client' : 'inconnu'),
        })),
      });
    }

    // ── Téléchargement d'un document (vérifie visibilité + accès au dossier) ──
    if (action === 'document' && req.method === 'GET') {
      const docId = +id;
      const { data: doc } = await supabase
        .from('case_documents')
        .select('project_id, title, filename, mime, data, visible_to_client, confidential')
        .eq('id', docId)
        .maybeSingle();
      if (!doc) return res.status(404).send('Document introuvable');
      if (!doc.visible_to_client || doc.confidential) return res.status(403).send('Accès refusé');
      const allowed = await clientHasAccessToCase(c.id, doc.project_id) || (c.project_id === doc.project_id);
      if (!allowed) return res.status(403).send('Accès refusé');
      const buf = caseDocBufFromRow(doc.data);
      if (!buf) return res.status(500).send('Format binaire inconnu');
      const filename = (doc.filename || doc.title || `doc-${docId}`).replace(/[\r\n"]/g, '_');
      res.set({
        'Content-Type': doc.mime || 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store, private',
      });
      return res.end(buf);
    }

    // ── Honoraires : factures visibles + paiements de ce dossier ──────────────
    if (action === 'invoices' && req.method === 'GET') {
      const projectId = +id;
      const allowed = await clientHasAccessToCase(c.id, projectId) || (c.project_id === projectId);
      if (!allowed) return res.status(403).json({ error: 'Accès refusé' });
      const { data: invoices } = await supabase
        .from('case_invoices')
        .select('id, invoice_number, title, description, amount, currency, status, due_date, sent_at, paid_amount, paid_at, notes_client, created_at')
        .eq('project_id', projectId)
        .eq('visible_to_client', true)
        .neq('status', 'brouillon')   // pas de brouillons côté client
        .order('created_at', { ascending: false });
      const invoiceIds = (invoices ?? []).map((i) => i.id);
      let payments = [];
      if (invoiceIds.length) {
        const { data: pays } = await supabase
          .from('case_payments')
          .select('id, invoice_id, amount, paid_at, method, reference')
          .in('invoice_id', invoiceIds)
          .order('paid_at', { ascending: false });
        payments = pays ?? [];
      }
      return res.json({ invoices: invoices ?? [], payments });
    }

    // ── Demandes RDV : client soumet une nouvelle demande ─────────────────────
    if (action === 'request_event' && req.method === 'POST') {
      const projectId = +id;
      const allowed = await clientHasAccessToCase(c.id, projectId) || (c.project_id === projectId);
      if (!allowed) return res.status(403).json({ error: 'Accès refusé' });
      const b = req.body || {};
      if (!b.title || !b.proposed_date) return res.status(400).json({ error: 'Titre et date proposée requis.' });
      const payload = {
        project_id: projectId,
        client_id: c.id,
        type: ['audience','rdv','consultation','autre'].includes(b.type) ? b.type : 'rdv',
        title: String(b.title).trim().slice(0, 240),
        proposed_date: b.proposed_date,
        alternative_date: b.alternative_date || null,
        message: b.message ? String(b.message).slice(0, 4000) : null,
        status: 'pending',
      };
      const { data, error } = await supabase.from('case_event_requests').insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      sendWhatsApp(`📅 *Demande RDV client (Afrilex)*\n👤 ${c.name}\n📁 Dossier #${projectId}\n📋 ${payload.title}\n🕒 Proposé : ${new Date(payload.proposed_date).toLocaleString('fr-FR')}${payload.alternative_date ? `\n🕒 Alt. : ${new Date(payload.alternative_date).toLocaleString('fr-FR')}` : ''}${payload.message ? `\n💬 ${payload.message.slice(0, 200)}` : ''}\n\n🔗 /bureau/projets`);
      return res.json({ success: true, request: data });
    }
    if (action === 'my_event_requests' && req.method === 'GET') {
      const projectId = +id;
      const allowed = await clientHasAccessToCase(c.id, projectId) || (c.project_id === projectId);
      if (!allowed) return res.status(403).json({ error: 'Accès refusé' });
      const { data, error } = await supabase
        .from('case_event_requests')
        .select('*')
        .eq('project_id', projectId)
        .eq('client_id', c.id)
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data ?? []);
    }

    // ── Le client envoie une pièce au cabinet ─────────────────────────────────
    if (action === 'upload_document' && req.method === 'POST') {
      const projectId = +id;
      const allowed = await clientHasAccessToCase(c.id, projectId) || (c.project_id === projectId);
      if (!allowed) return res.status(403).json({ error: 'Accès refusé' });
      const b = req.body || {};
      const mime = String(b.mime || '');
      if (!CASE_DOC_MIMES.has(mime)) return res.status(415).json({ error: 'Type non supporté (PDF/DOC/DOCX/XLS/XLSX/JPG/PNG/WEBP/TXT).' });
      if (typeof b.data_base64 !== 'string' || b.data_base64.length < 64) return res.status(400).json({ error: 'data_base64 absent ou invalide' });
      const buf = Buffer.from(b.data_base64.replace(/^data:[^,]+,/, ''), 'base64');
      if (buf.length === 0) return res.status(400).json({ error: 'Document vide' });
      if (buf.length > CASE_DOC_MAX) return res.status(413).json({ error: `Document trop lourd (max ${CASE_DOC_MAX/1024/1024} Mo)` });
      const payload = {
        project_id: projectId,
        title: String(b.title ?? b.filename ?? 'Pièce client').trim().slice(0, 240),
        kind: ['preuve','contrat','jugement','conclusions','expertise','correspondance','identite','autre'].includes(b.kind) ? b.kind : 'autre',
        description: b.description ? String(b.description).slice(0, 4000) : null,
        filename: b.filename ? String(b.filename).slice(0, 240) : null,
        mime,
        size_bytes: buf.length,
        data: caseDocBytea(buf),
        uploaded_by_client_id: c.id,
        visible_to_client: true,
        confidential: false,
      };
      const { data, error } = await supabase.from('case_documents')
        .insert(payload)
        .select('id, title, kind, filename, mime, size_bytes, created_at')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      sendWhatsApp(`📎 *Nouvelle pièce client (Afrilex)*\n👤 ${c.name}\n📁 Dossier #${projectId}\n📄 ${payload.title} (${(buf.length/1024).toFixed(0)} Ko)\n\n🔗 /bureau/projets\n⏰ ${new Date().toLocaleString('fr-FR')}`);
      return res.json({ success: true, document: data });
    }

    // ── SIGNATURES électroniques (côté client) ───────────────────────────
    if (action === 'signatures_pending' && req.method === 'GET') {
      // Toutes les signatures en attente pour ce client (tous dossiers)
      const { data, error } = await supabase
        .from('case_signatures')
        .select('id, project_id, document_id, title, content_text, status, expires_at, created_at, project:projects!project_id(name, case_number)')
        .eq('client_id', c.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json((data ?? []).map((s) => ({
        ...s,
        case_name: s.project?.name ?? null, case_number: s.project?.case_number ?? null,
        project: undefined,
      })));
    }
    if (action === 'signatures_history' && req.method === 'GET') {
      const { data, error } = await supabase
        .from('case_signatures')
        .select('id, project_id, title, status, signed_at, signed_name, created_at, project:projects!project_id(name, case_number)')
        .eq('client_id', c.id)
        .in('status', ['signed', 'refused', 'cancelled', 'expired'])
        .order('signed_at', { ascending: false, nullsFirst: false })
        .limit(50);
      if (error) return res.status(500).json({ error: error.message });
      return res.json((data ?? []).map((s) => ({
        ...s,
        case_name: s.project?.name ?? null, case_number: s.project?.case_number ?? null,
        project: undefined,
      })));
    }
    if (action === 'signature_sign' && req.method === 'POST') {
      const sigId = +id;
      const b = req.body || {};
      const fullName = String(b.full_name || '').trim();
      if (!fullName || fullName.length < 4) return res.status(400).json({ error: 'Veuillez taper votre nom complet (4 caractères minimum).' });
      if (!b.accept) return res.status(400).json({ error: 'Veuillez accepter pour signer.' });
      const { data: sig } = await supabase.from('case_signatures').select('*').eq('id', sigId).eq('client_id', c.id).maybeSingle();
      if (!sig) return res.status(404).json({ error: 'Signature introuvable' });
      if (sig.status !== 'pending') return res.status(409).json({ error: 'Cette signature n\'est plus en attente.' });
      if (sig.expires_at && new Date(sig.expires_at) < new Date()) {
        await supabase.from('case_signatures').update({ status: 'expired' }).eq('id', sigId);
        return res.status(410).json({ error: 'Cette signature a expiré.' });
      }
      const signedAt = new Date().toISOString();
      const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
      const ua = String(req.headers['user-agent'] || '').slice(0, 500);
      const hash = require('crypto').createHash('sha256').update(`${sig.content_text}|${fullName}|${signedAt}|${ip}`).digest('hex');
      const { error: uErr } = await supabase.from('case_signatures').update({
        status: 'signed', signed_at: signedAt, signed_name: fullName,
        signed_ip: ip, signed_user_agent: ua, signed_hash: hash,
      }).eq('id', sigId);
      if (uErr) return res.status(500).json({ error: uErr.message });
      sendWhatsApp(`✍️ *Signature électronique (Afrilex)*\n👤 ${c.name} (${fullName})\n📄 ${sig.title}\n📁 Dossier #${sig.project_id}\n⏰ ${new Date().toLocaleString('fr-FR')}`);
      return res.json({ success: true, signed_at: signedAt, hash });
    }
    if (action === 'signature_refuse' && req.method === 'POST') {
      const sigId = +id;
      const reason = String((req.body || {}).reason || '').slice(0, 1000);
      const { data: sig } = await supabase.from('case_signatures').select('id,status').eq('id', sigId).eq('client_id', c.id).maybeSingle();
      if (!sig) return res.status(404).json({ error: 'Signature introuvable' });
      if (sig.status !== 'pending') return res.status(409).json({ error: 'Cette signature n\'est plus en attente.' });
      const { error } = await supabase.from('case_signatures').update({
        status: 'refused', refused_at: new Date().toISOString(), refused_reason: reason,
      }).eq('id', sigId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true });
    }

    // ── PDF FACTURE (téléchargement côté client) ─────────────────────────
    if (action === 'invoice_pdf' && req.method === 'GET') {
      const invoiceId = +id;
      const { data: invoice } = await supabase.from('case_invoices').select('*').eq('id', invoiceId).maybeSingle();
      if (!invoice) return res.status(404).send('Facture introuvable');
      if (!(await clientHasAccessToCase(c.id, invoice.project_id))) return res.status(403).send('Accès refusé');
      if (invoice.status === 'brouillon' || invoice.status === 'annulee') return res.status(404).send('Facture indisponible');
      const [{ data: project }, { data: payments }, { data: links }] = await Promise.all([
        supabase.from('projects').select('id, name, case_number, practice_area').eq('id', invoice.project_id).maybeSingle(),
        supabase.from('case_payments').select('*').eq('invoice_id', invoiceId).order('paid_at'),
        supabase.from('case_clients').select('client:clients(name,email,phone,company)').eq('project_id', invoice.project_id).eq('client_id', c.id),
      ]);
      const clients = (links ?? []).map((l) => l.client).filter(Boolean);
      try {
        const buf = await buildInvoicePdfBuffer({ invoice, payments: payments ?? [], project, clients });
        const filename = `facture-${invoice.invoice_number || invoice.id}.pdf`;
        res.set({
          'Content-Type': 'application/pdf',
          'Content-Length': String(buf.length),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store, private',
        });
        return res.end(buf);
      } catch (e) {
        console.error('client invoice_pdf', e);
        return res.status(500).send(String(e?.message || e));
      }
    }

    return res.status(404).json({ error: 'Action non trouvée' });
  } catch (e) {
    console.error('client/cases.php', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CHAT IA — Proxy Groq
// ══════════════════════════════════════════════════════════════════════════════
const GROQ_KEY = process.env.GROQ_API_KEY || '';

app.post('/api/chat.php', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages requis' });

  const system = `Tu es AFRI, l'assistant IA officiel d'Afrilex Conseil (cabinet d'assistance juridique, fiscale et comptable, Ouagadougou, Burkina Faso).
Zones d'intervention du cabinet : Afrique de l'Ouest, autres pays OHADA, diaspora.
Tu es professionnel, chaleureux, concis et orienté solutions.
Tu réponds TOUJOURS en français sauf si le client parle anglais.
Tu n'inventes jamais de conseils juridiques précis : tu orientes vers le cabinet pour les dossiers concrets.

Expertises : droit des affaires & contrats ; fiscalité & optimisation (cadre légal) ; comptabilité & conformité ; structuration & financement ; conformité & gouvernance (dont OHADA) ; accompagnement investisseurs.
Contact : info@afrilexconseil.com | WhatsApp / tél. +226 52 20 91 91 | Réponse sous 24h ouvrées.
Blog : https://afrilexconseil.com/blog/

Règles : 3-4 lignes max sauf détails demandés ; **gras** pour les infos clés ; proposer une prochaine étape (contact, rendez-vous).
Si la personne veut être rappelée ou mandater le cabinet, demande NOM et TÉLÉPHONE. Quand tu as les deux, ajoute à la fin :
[LEAD:nom=NOM COMPLET|tel=NUMÉRO|sujet=SUJET COURT]`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: system }, ...messages.slice(-10)], temperature: 0.7, max_tokens: 512 }),
    });
    const d = await r.json();
    let text = d.choices?.[0]?.message?.content ?? 'Désolé, erreur technique.';
    let lead = false;
    const lm = text.match(/\[LEAD:nom=([^|]+)\|tel=([^|]+)\|sujet=([^\]]+)\]/i);
    if (lm) {
      sendWhatsApp(`🤖 *Lead chat Afrilex Conseil*\n👤 ${lm[1].trim()}\n📞 ${lm[2].trim()}\n🎯 ${lm[3].trim()}\n⏰ ${new Date().toLocaleString('fr-FR')}`);
      text = text.replace(/\[LEAD:[^\]]+\]/gi, '').trim();
      lead = true;
    }
    return res.json({ success: true, message: text, lead });
  } catch(e) {
    return res.status(500).json({ error: 'Erreur IA : ' + e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ASSISTANT MÉTIER AGENTS — Groq + base locale Markdown (api/bureau/kb)
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/bureau/assistant.php', async (req, res) => {
  const u = await authGuard(req, res); if (!u) return;
  if (!permGuard(req, res, 'assistant')) return;
  if (!GROQ_KEY) {
    return res.status(503).json({
      error: 'Clé Groq absente — définissez GROQ_API_KEY dans .env.local (même variable que chat public).',
    });
  }
  const modeRaw = req.body.mode || 'assist';
  const mode = normalizeAssistantMode(modeRaw);
  const dossier = req.body.dossier && typeof req.body.dossier === 'object' ? req.body.dossier : {};
  const messages = sanitizeAssistantMessages(req.body.messages);
  if (messages.length === 0) return res.status(400).json({ error: 'messages[] requis (user|assistant avec contenu non vide)' });

  let system = `Tu es l'assistant métier exclusif des agents connectés d'Afrilex Conseil (cabinet juridique et droit des affaires ; zones d'intervention : Afrique de l'Ouest, autres pays OHADA, diaspora).
Réponds en français. Reste prudent : pas de garantie de résultat ; ne cite des numéros d'articles officiels que si le contexte ou la base ci-dessous les indique clairement, sinon propose une orientation et renvoie vers les sources officielles.
CONSIGNÉ : rappeler régulièrement que toute pièce ou stratégie doit être validée par l'associé référent.

Base de synthèses internes (non officielles, compléter par vos recherches) :
"""
${loadKbBureauMarkdown()}
"""`;

  if (mode === 'memo_defense') {
    system += `\nMODE : BROUILLON de mémoire de défense / conclusions / écritures adverses. Produis du Markdown structuré (titres, listes) avec [À compléter] pour les faits ou pièces manquants. Termine par un bloc « AVERTISSEMENT CABINET » (brouillon IA, vérification obligatoire avant dépôt).`;
    const keys = [
      'reference', 'juridiction', 'pieces', 'objectif', 'contraintes_delais',
      'client', 'demandeur', 'resume_faits', 'theses_principales', 'points_de_droit', 'conclusions_souhaitees',
    ];
    const parts = [];
    for (const k of keys) {
      const v = dossier[k];
      if (v != null && String(v).trim() !== '') parts.push(`${k}=${String(v).trim()}`);
    }
    const memoLitige = dossier.memo_litige;
    if (memoLitige != null && String(memoLitige).trim() !== '' && !dossier.resume_faits) {
      parts.push(`synopsis_litige=${String(memoLitige).trim()}`);
    }
    if (parts.length) system += '\nInformations dossier renseignées par l\'agent : ' + parts.join(' | ');
  }

  const temperature = mode === 'memo_defense' ? 0.25 : 0.45;
  const max_tokens  = mode === 'memo_defense' ? 8192 : 2600;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: system }, ...messages],
        temperature,
        max_tokens,
      }),
    });
    const d = await r.json();
    const msg = d.choices?.[0]?.message?.content ?? '';
    if (!msg || r.status !== 200) return res.status(503).json({ error: d.error?.message || 'Assistant Groq indisponible.' });
    return res.json({
      success: true,
      message: msg,
      reply: msg,
      model: 'llama-3.3-70b-versatile',
      mode,
      mode_requested: modeRaw,
      kb_attached: true,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE — migrations avant écoute (évite connexion avant création des comptes)
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;

seedCabinetDemoIfTotallyEmpty()
  .then(() => ensureBootstrapAdminExists())
  .then(() => ensureAfrilexAgentBootstrapUser())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Afrilex Conseil API (Supabase) — http://localhost:${PORT}`);
      console.log(`   GET http://localhost:${PORT}/api/bureau/health — test tables users/sessions`);
      console.log(`   🗄️  ${SUPABASE_URL}`);
      console.log(`   📱 WhatsApp : +${WA_PHONE}`);
      if (!META_ACCESS_TOKEN) console.log('   ⚠️  WhatsApp → console (dev mode)');
      console.log('');
      if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
        console.log(
          '💡 Bureau : « sagnon » / « sagnon » ou « afrilex_agent » / « AfrilexBureau2026! » — changez en production.\n' +
            '   Réinit. hash secours : AFRILEX_SYNC_AGENT_LOGIN=1 ; « sagnon » : AFRILEX_LOCAL_SYNC_SAGNON=1\n',
        );
      }
    });
  })
  .catch((err) => {
    console.error('\n❌ Impossible d’initialiser la base / Supabase avant démarrage :', err?.message || err);
    console.error('   Vérifiez SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY et que sql/supabase-setup.sql a été exécuté.\n');
    process.exit(1);
  });
