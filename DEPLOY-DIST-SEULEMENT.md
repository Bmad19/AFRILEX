# Déploiement — vous : uniquement `dist/` sur LWS

L’API Render et le code sont gérés via **GitHub** (`Bmad19/AFRILEX`).  
Render redéploie automatiquement après chaque push sur `main`.

## Votre seule action

1. Sur votre PC : vérifiez que `dist/` est à jour (`npm run build` si besoin).
2. Uploadez **tout** le contenu de `C:\Users\HP\Desktop\afrilex\dist\` vers **public_html** sur LWS (FTP / gestionnaire de fichiers).
3. Videz le cache du navigateur (Ctrl+F5).
4. Bureau → reconnexion → test envoi mail.

## Fichiers importants dans `dist/`

- `index.html`, `assets/`, `.htaccess`, `runtime-config.js`
- `api/bureau/mailbox-send.php`
- `api/bureau/mailbox-lib.php`
- `api/mailbox-relay.config.php`
- `api/.htaccess`, `api/bureau/.htaccess`

## Test rapide après upload

- [https://www.afrilexconseil.com/api/bureau/mailbox-send.php?ping=1](https://www.afrilexconseil.com/api/bureau/mailbox-send.php?ping=1) → `"ok":true,"supabase":true`

## API Render (rien à faire de votre côté)

- [https://afrilex.onrender.com/api/bureau/health](https://afrilex.onrender.com/api/bureau/health)
