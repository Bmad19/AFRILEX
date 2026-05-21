/**
 * Variables publiques d’API : d’abord dist/runtime-config.js (modifiable sur l’hébergeur),
 * sinon valeurs compilées depuis .env.production au moment du build.
 */
export type AfrilexPublicConfig = Partial<{
  VITE_BUREAU_API: string;
  VITE_CLIENT_API: string;
  VITE_CHAT_API_URL: string;
  VITE_API_URL: string;
  VITE_CAREERS_API_URL: string;
  VITE_WP_REST_BASE: string;
  /** Envoi boîte mail (PHP LWS, same-origin) */
  VITE_MAIL_SEND_API: string;
}>;

declare global {
  interface Window {
    __AFRILEX_CONFIG__?: AfrilexPublicConfig;
  }
}

/**
 * En `vite` / `npm run dev` : par défaut toutes les API passent par le proxy Vite → API Node locale
 * (`localhost:8080`), même si `.env.local` duplique les URLs Render de la production.
 * Pour tester le front contre l’API distante : `VITE_USE_REMOTE_API=true` dans `.env.local`.
 */
const DEV_LOCAL_API_PATHS: Partial<Record<keyof AfrilexPublicConfig, string>> = {
  VITE_BUREAU_API: "/api/bureau",
  VITE_CLIENT_API: "/api/client",
  VITE_CHAT_API_URL: "/api/chat.php",
  VITE_API_URL: "/api/contact.php",
  VITE_CAREERS_API_URL: "/api/careers.php",
};

export function readRuntimeEnv(key: keyof AfrilexPublicConfig, fallback: string): string {
  if (
    typeof import.meta !== "undefined" &&
    import.meta.env?.DEV &&
    import.meta.env?.VITE_USE_REMOTE_API !== "true"
  ) {
    const local = DEV_LOCAL_API_PATHS[key];
    if (local !== undefined) return local;
  }

  if (typeof window !== "undefined") {
    const override = window.__AFRILEX_CONFIG__?.[key];
    if (typeof override === "string") {
      const t = override.trim();
      if (t) return t;
    }
  }
  const raw = import.meta.env[key as keyof ImportMetaEnv];
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t) return t;
  }
  return fallback;
}
