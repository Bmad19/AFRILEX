/**
 * Afrilex — configuration runtime (optionnel).
 * Ce fichier est copié dans dist/ à la racine avec index.html.
 *
 * Chaînes vides "" → valeurs compilées au dernier « npm run build » (.env.production).
 *
 * Blog :
 * - Les articles viennent de blog-feed.json (généré au build depuis WordPress).
 * - Les commentaires utilisent l’origine de VITE_API_URL (formulaire contact) ;
 *   gardez-la à jour si vous changez l’URL Render sans refaire un build JS complet.
 */
window.__AFRILEX_CONFIG__ = window.__AFRILEX_CONFIG__ || {
  VITE_BUREAU_API: "",
  VITE_CLIENT_API: "",
  VITE_CHAT_API_URL: "",
  VITE_API_URL: "",
  VITE_CAREERS_API_URL: "",
  VITE_WP_REST_BASE: "",
  /** Envoi boîte mail : PHP sur le même domaine (LWS) — ne pas pointer vers Render */
  VITE_MAIL_SEND_API: "/api/bureau/mailbox-send.php",
};
