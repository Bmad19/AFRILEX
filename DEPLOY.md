# Afrilex Conseil — Déploiement en ligne (dossier projet sur votre bureau)

**Emplacement du projet sur votre PC :** `C:\Users\HP\Desktop\afrilex` — c’est **ce dossier** qui contient le site et l’API (`npm start`). Pour Render ou Railway, vous devez **pousser ce même code sur Git** (GitHub / GitLab / etc.) ; la racine du dépôt doit être le contenu de ce dossier `afrilex`.

**Guide détaillé uniquement Supabase + Render (clics, copies d’URL, variables) :** ouvrez **`DEPLOY-SUPABASE-RENDER.md`** dans ce même dossier.

Le site est une **SPA React**. Le bureau, l’espace client et les leads passent par une **API Node** reliée à **Supabase**. Suivez les étapes **dans l’ordre**.

---

## Guide pas à pas (à suivre dans l’ordre)

### Phase A — Supabase (base de données)

| # | Action | Détail |
|---|--------|--------|
| **A1** | Créer un compte et un projet | [supabase.com](https://supabase.com) → **New project** → région + mot de passe DB. |
| **A2** | Noter l’URL et la clé serveur | **Project Settings → API** : **`Project URL`** et clé **`service_role`** (**secret** — jamais dans le front ni sur un dépôt public). |
| **A3** | Créer les tables | **SQL Editor → New query** → ouvrez **`sql/supabase-setup.sql`** **dans ce dossier afrilex** → collez tout → **Run**. |
| **A4** *(optionnel)* | Commentaires blog | Exécutez **`scripts/sql/afrilex_blog_comments.sql`** dans SQL Editor si vous utilisez les commentaires SPA. |

Après **A3**, les comptes bureau initiaux sont créés au **premier démarrage réussi** de l’API (étape B) — dont **`sagnon`** / **`sagnon`** (à changer en production). Compte secours possible : **`afrilex_agent`** (voir `env.example`).

---

### Phase B — API Node sur Internet (ex. Render)

| # | Action | Détail |
|---|--------|--------|
| **B1** | Code sur Git | Créez un dépôt avec le contenu du dossier **`afrilex`**, puis poussez-y le code (`git push`). |
| **B2** | Service web | **Render** → **New +** → **Blueprint** → branchez le dépôt → fichier **`render.yaml`** à la racine **ou** **Web Service** Node, racine du repo = projet **afrilex**. |
| **B3** | Build / Start | **Build** : `npm ci` — **Start** : `npm start`. Node **20+** (voir `package.json` → `engines`). |
| **B4** | Variables | **`SUPABASE_URL`**, **`SUPABASE_SERVICE_ROLE_KEY`**, **`GROQ_API_KEY`** (conseillé). Boîte mail : copier **`MAILBOX_LWS_PROXY_URL`** et **`MAILBOX_PROXY_SECRET`** depuis **`.env.mailbox-relay.local`** (voir **`MAILBOX-RELAY.md`**). |
| **B5** | URL du service | Copiez l’URL publique (ex. `https://afrilex-api-xxxx.onrender.com`) **sans** slash final. |
| **B6** | Test | Ouvrez **`https://VOTRE-URL/api/bureau/health`** → JSON **`{"ok":true}`**. |

Fichier **`render.yaml`** : service Web + healthcheck `/api/bureau/health` ; secrets à saisir dans l’interface Render.

---

### Phase C — Build sur votre PC (dans le dossier afrilex)

| # | Action | Détail |
|---|--------|--------|
| **C1** | Terminal | `cd C:\Users\HP\Desktop\afrilex` |
| **C2** | `.env.production` | Copiez **`.env.production.example`** → **`.env.production`**. |
| **C3** | URL API | Remplacez **`VOTRE-API.example.com`** par l’URL **B5** sur les **quatre** lignes `VITE_*`. |
| **C4** | WordPress | **`VITE_WP_REST_BASE`** : utilisée **sur votre PC** pendant **`npm run build`** pour générer **`blog-feed.json`** (articles copiés dans **`dist/`**). Les visiteurs ne dépendent plus de `/wp-json` sur le domaine du site. |
| **C5** | Build | `npm ci` puis **`npm run build`** : vérif `.env.production` → synchro WordPress → **`blog-feed.json`** → Vite → **`dist/`**. |
| **C5b** | *(optionnel)* | Éditer **`dist/runtime-config.js`** sur l’hébergeur pour changer les URLs sans refaire un build. |
| **C6** | Upload | **Tout** **`dist/`** : **`blog-feed.json`**, **`runtime-config.js`**, **`.htaccess`**, **`assets/`**, **`index.html`**, et **`api/bureau/mailbox-send.php`** + **`api/mailbox-relay.config.php`** (relais boîte mail — voir **`MAILBOX-RELAY.md`**). Commentaires blog : **`VITE_API_URL`** doit pointer vers votre API (ex. Render), comme le contact. |

---

### Phase D — Hébergement du site statique

Uploadez **tout** le contenu de **`dist/`** vers **`public_html`** (ou le dossier du domaine **afrilexconseil.com**). Le **`.htaccess`** doit être à la racine du site (fourni via `public/` au build).

Avec Supabase + API Node, vous **n’avez pas besoin** d’uploader **`api/*.php`** pour le bureau si le front utilise uniquement les URLs **`VITE_*`**.

#### Blog (articles + commentaires)

- **Articles** : intégrés dans **`blog-feed.json`** à chaque build. Uploadez ce fichier avec le reste de **`dist/`** ; plus besoin d’exposer `/wp-json` sur le domaine du site vitrine.
- **Commentaires** : le navigateur appelle **`https://VOTRE-API/api/blog/comments`** (origine dérivée de **`VITE_API_URL`**). Sur Render, gardez **`CORS_ORIGINS`** avec l’URL exacte du site.

Pour **rafraîchir les articles** après des publications WordPress : refaire **`npm run build`** sur votre PC, puis ré‑uploader **`dist/`** (au minimum **`blog-feed.json`** et les **`assets/`** si le JS change).

---

### Phase E — Vérifications

| # | Test | Attendu |
|---|------|--------|
| **E1** | Site public | Page d’accueil OK. |
| **E2** | F12 → Réseau | Pas de **CORS** bloqué vers l’API. |
| **E3** | `/bureau` | Login puis changement de mot de passe si premier accès. |
| **E4** | Contact | Lead enregistré côté Supabase. |

Si CORS bloque : sur Render, variable **`CORS_ORIGINS`** avec l’URL exacte du site (`https://www...` et `https://...` si les deux existent).

---

## Rappels

- **`SUPABASE_SERVICE_ROLE_KEY`** : uniquement sur le serveur Node (Render), pas dans `.env.production`.
- Fichiers utiles : **`env.example`**, **`render.yaml`**, **`scripts/verify-production-env.mjs`**.

---

## Architecture

```
Navigateur → https://afrilexconseil.com  →  fichiers statiques (dist/)
                ↓
           https://votre-api.onrender.com  →  bureau-api.cjs  →  Supabase
```

---

## Scripts SQL (ordre)

1. **`sql/supabase-setup.sql`** — schéma complet  
2. **`scripts/sql/afrilex_blog_comments.sql`** — optionnel  
3. **`sql/supabase_leads_archive_status.sql`** — seulement si migration d’une ancienne base  

---

## Variables serveur (API Node)

| Variable | Obligatoire |
|----------|-------------|
| `SUPABASE_URL` | Oui |
| `SUPABASE_SERVICE_ROLE_KEY` | Oui |
| `GROQ_API_KEY` | Très conseillé |
| `CORS_ORIGINS` | Si domaine non couvert par défaut |
| WhatsApp (`META_*`, `WA_PHONE`) | Optionnel |

---

## Dépannage

| Problème | Piste |
|----------|--------|
| CORS | `CORS_ORIGINS` ; `www` vs sans `www` |
| Login 500 | Logs API ; **`/api/bureau/health`** ; refaire **`sql/supabase-setup.sql`** |
| Chat mort | **`GROQ_API_KEY`** sur le service |
| Routes 404 | **`.htaccess`** à la racine |
| `build:prod` échoue | `.env.production` absent ou encore `example.com` |

---

## Annexe — Hébergement PHP + MySQL uniquement (sans Node)

Import **`sql/setup.sql`** en MySQL, config **`api/config.php`**, uploadez **`dist/`** + **`api/`**. La version complète bureau/leads avec ce projet reste **Supabase + API Node** ci‑dessus.
