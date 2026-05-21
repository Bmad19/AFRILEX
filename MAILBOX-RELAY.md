# Boîte mail — envoi via LWS

## Fonctionnement

1. Le **navigateur** appelle `https://votresite.com/api/bureau/mailbox-send.php` (dans `dist/`).
2. Le PHP sur LWS vérifie votre session Supabase.
3. Le PHP demande à **Render** de déchiffrer le mot de passe du compte mail (`mail_password`).
4. Le PHP envoie le mail via **SMTP LWS** (mail du domaine).

## Déploiement

| Étape | Action |
|--------|--------|
| 1 | `npm run build` sur votre PC |
| 2 | Uploader **tout** `dist/` sur LWS |
| 3 | **Une fois** : redéployer l’API sur Render (Git push ou deploy manuel) — nouvel endpoint `mail_password` |

Sans le redéploiement Render, le déchiffrement du mot de passe échouera.

## Test

1. [https://www.afrilexconseil.com/api/bureau/mailbox-send.php?ping=1](https://www.afrilexconseil.com/api/bureau/mailbox-send.php?ping=1) → `"supabase":true`
2. Bureau → déconnexion / reconnexion → Boîte mail → envoi test

## Erreur « Identifiants SMTP »

Modifiez le compte mail dans le bureau et **ressaisissez le mot de passe** LWS (celui de Roundcube).
