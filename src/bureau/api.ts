// ── Afrilex Conseil Bureau — Client API centralisé ───────────────────────────
import { readRuntimeEnv } from "../lib/runtimeEnv";

const BASE = readRuntimeEnv("VITE_BUREAU_API", "/api/bureau");

function getToken(): string | null { return localStorage.getItem('bureau_token'); }

/** Production : PHP LWS same-origin. Dev local : null → API Node (mailbox.php). */
function mailboxSendPhpUrl(): string | null {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_REMOTE_API !== "true") {
    return null;
  }
  const custom = readRuntimeEnv("VITE_MAIL_SEND_API", "");
  if (custom.trim()) {
    const c = custom.trim();
    if (/^https?:\/\//i.test(c)) return c;
    if (typeof window !== "undefined") {
      return new URL(c.startsWith("/") ? c : `/${c}`, window.location.origin).href;
    }
    return c;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/bureau/mailbox-send.php`;
  }
  return null;
}

async function mailboxLwsRequest<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T> {
  const url = mailboxSendPhpUrl();
  if (!url) throw new Error("Envoi mail : PHP LWS non configuré");

  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(90_000)
      : undefined;

  const token = getToken();
  if (!token) {
    throw new Error("Non connecté — reconnectez-vous au bureau.");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...body, bureau_token: token }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Envoi mail LWS indisponible (${msg}). Re-uploadez tout dist/ (dossier api/bureau/).`,
    );
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { error: text?.slice(0, 400) || `Réponse invalide (${res.status})` };
  }

  if (!res.ok || data.success === false) {
    const parts = [data.error, data.hint].filter(Boolean) as string[];
    if (data.via === "lws" || data.via === "lws_proxy") parts.unshift("(serveur LWS)");
    if (data.needs_smtp_password) parts.push("needs_smtp_password");
    const attempted = data.attempted as Array<{ error?: string; host?: string; port?: number }> | undefined;
    if (Array.isArray(attempted) && attempted.length) {
      const last = attempted.filter((a) => a.error).slice(-2);
      const lines = last.map((a) => `${a.host ?? ""}:${a.port ?? ""} ${a.error ?? ""}`.trim());
      if (lines.length) parts.push(lines.join(" · "));
    }
    throw new Error(parts.length ? parts.join(" — ") : `Erreur envoi (${res.status})`);
  }
  return data as T;
}

async function request<T = unknown>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
  params?: Record<string, string>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const url = new URL(`${BASE}/${endpoint}`, window.location.origin);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const isMailboxSend = endpoint.includes('mailbox') && params?.action === 'send';
  const timeoutMs = opts?.timeoutMs ?? (isMailboxSend ? 120_000 : undefined);
  const signal = timeoutMs && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      mode: "cors",
      credentials: "omit",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const apiHint =
      /^https?:\/\//i.test(BASE)
        ? `API : ${BASE.replace(/\/api\/bureau\/?$/i, "")}. Testez …/api/bureau/health. En ligne : sur Render ajoutez CORS_ORIGINS avec l’URL exacte de ce site (schéma https + domaine, ex. avec ou sans www).`
        : "Production : rebuild avec .env.production et VITE_BUREAU_API vers votre API déployée. En local : « npm run dev » + « npm run dev:api » (ou « npm run dev:full ») ; Vite utilise souvent le port 3100 (voir la console), l’API le 8080 ; fichier .env.local à la racine avec SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY (obligatoires pour démarrer l’API). Sans VITE_BUREAU_API, les appels passent par /api/bureau (proxy Vite → 8080). Groq : GROQ_API_KEY dans .env.local pour l’assistant.";
    throw new Error(`Impossible de joindre l’API bureau (${msg}). ${apiHint}`);
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { error: text?.slice(0, 400) || `Réponse invalide (${res.status})` };
  }

  if (!res.ok) {
    const parts = [data.error, data.detail, data.hint].filter(Boolean) as string[];
    const via = typeof data.via === 'string' ? data.via : '';
    if (via === 'lws_proxy') parts.unshift('(relais LWS)');
    const attempted = data.attempted as Array<{ host?: string; port?: number; secure?: boolean; ok?: boolean; error?: string; via?: string }> | undefined;
    if (Array.isArray(attempted) && attempted.length) {
      const fail = attempted.filter((a) => !a.ok).slice(-4);
      const lines = fail.map((a) => {
        const tag = a.via === 'lws_proxy' ? 'LWS' : '';
        const h = a.host && a.host !== 'lws_proxy' ? `${a.host}:` : tag;
        return `${h}${a.port ? a.port : ''} ${a.error ? `→ ${String(a.error).slice(0, 100)}` : ''}`.trim();
      }).filter(Boolean);
      if (lines.length) parts.push(lines.join(' · '));
    }
    throw new Error(parts.length ? parts.join(" — ") : `Erreur ${res.status}`);
  }
  return data as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  login:          (u: string, p: string) => request<{ token: string; first_login: boolean; user: BureauUser }>('auth.php', 'POST', { username: u, password: p }, { action: 'login' }),
  logout:         () => request('auth.php', 'POST', {}, { action: 'logout' }),
  me:             () => request<BureauUser>('auth.php', 'GET', undefined, { action: 'me' }),
  changePassword: (old_password: string, new_password: string) => request('auth.php', 'POST', { old_password, new_password }, { action: 'change_password' }),
  updateProfile:  (data: Partial<BureauUser>) => request('auth.php', 'PUT', data, { action: 'profile' }),
};

// ── Users ────────────────────────────────────────────────────────────────────
export const usersApi = {
  list:          () => request<BureauUser[]>('users.php', 'GET', undefined, { action: 'list' }),
  create:        (data: Partial<BureauUser> & { password: string }) => request('users.php', 'POST', data, { action: 'create' }),
  update:        (id: number, data: Partial<BureauUser>) => request('users.php', 'PUT', data, { action: 'update', id: String(id) }),
  delete:        (id: number) => request('users.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
  resetPassword: (id: number, password: string) => request('users.php', 'POST', { password }, { action: 'reset_password', id: String(id) }),
};

// ── Projects ─────────────────────────────────────────────────────────────────
export const projectsApi = {
  list:   () => request<Project[]>('projects.php', 'GET', undefined, { action: 'list' }),
  get:    (id: number) => request<Project>('projects.php', 'GET', undefined, { action: 'get', id: String(id) }),
  create: (data: Partial<Project>) => request('projects.php', 'POST', data, { action: 'create' }),
  update: (id: number, data: Partial<Project>) => request('projects.php', 'PUT', data, { action: 'update', id: String(id) }),
  updateMeta: (id: number, data: Partial<Pick<Project, 'case_number' | 'practice_area' | 'current_phase' | 'next_action' | 'next_action_date'>>) =>
    request('projects.php', 'PUT', data, { action: 'update_meta', id: String(id) }),
  delete: (id: number) => request('projects.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
  stats:  () => request<ProjectStats>('projects.php', 'GET', undefined, { action: 'stats' }),
};

// ── Cases (vue 360° d'un dossier + sous-collections) ─────────────────────────
export const casesApi = {
  get: (projectId: number) => request<CaseDetail>('cases.php', 'GET', undefined, { action: 'get', id: String(projectId) }),

  attachClient:    (projectId: number, clientId: number, role = 'principal') =>
    request('cases.php', 'POST', { client_id: clientId, role }, { action: 'attach_client', id: String(projectId) }),
  detachClient:    (projectId: number, clientId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'detach_client', id: String(projectId), client_id: String(clientId) }),

  milestoneCreate: (projectId: number, data: Partial<CaseMilestone>) =>
    request<{ success: boolean; milestone: CaseMilestone }>('cases.php', 'POST', data, { action: 'milestone_create', id: String(projectId) }),
  milestoneUpdate: (milestoneId: number, data: Partial<CaseMilestone>) =>
    request('cases.php', 'PUT', data, { action: 'milestone_update', id: String(milestoneId) }),
  milestoneDelete: (milestoneId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'milestone_delete', id: String(milestoneId) }),

  eventCreate: (projectId: number, data: Partial<CaseEvent>) =>
    request<{ success: boolean; event: CaseEvent }>('cases.php', 'POST', data, { action: 'event_create', id: String(projectId) }),
  eventUpdate: (eventId: number, data: Partial<CaseEvent>) =>
    request('cases.php', 'PUT', data, { action: 'event_update', id: String(eventId) }),
  eventDelete: (eventId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'event_delete', id: String(eventId) }),

  documentUpload: (projectId: number, payload: {
    title: string; kind?: CaseDocument['kind']; description?: string; filename?: string;
    mime: string; data_base64: string; visible_to_client?: boolean; confidential?: boolean;
  }) => request<{ success: boolean; document: CaseDocument }>('cases.php', 'POST', payload, { action: 'document_upload', id: String(projectId) }),
  documentUpdate: (docId: number, data: Partial<CaseDocument>) =>
    request('cases.php', 'PUT', data, { action: 'document_update', id: String(docId) }),
  documentDelete: (docId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'document_delete', id: String(docId) }),

  // Honoraires
  invoicesList:    (projectId: number) => request<{ invoices: CaseInvoice[]; payments: CasePayment[] }>('cases.php', 'GET', undefined, { action: 'invoices_list', id: String(projectId) }),
  invoiceCreate:   (projectId: number, data: Partial<CaseInvoice>) =>
    request<{ success: boolean; invoice: CaseInvoice }>('cases.php', 'POST', data, { action: 'invoice_create', id: String(projectId) }),
  invoiceUpdate:   (invoiceId: number, data: Partial<CaseInvoice>) =>
    request('cases.php', 'PUT', data, { action: 'invoice_update', id: String(invoiceId) }),
  invoiceDelete:   (invoiceId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'invoice_delete', id: String(invoiceId) }),
  paymentRecord:   (invoiceId: number, data: Partial<CasePayment>) =>
    request<{ success: boolean; paid_amount: number; status: string }>('cases.php', 'POST', data, { action: 'payment_record', id: String(invoiceId) }),
  paymentDelete:   (paymentId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'payment_delete', id: String(paymentId) }),

  // Demandes RDV
  eventRequestsList: (projectId?: number) =>
    request<CaseEventRequest[]>('cases.php', 'GET', undefined, { action: 'event_requests_list', id: String(projectId ?? 0) }),
  eventRequestDecide: (requestId: number, data: {
    decision: 'accepted' | 'rescheduled' | 'refused';
    message?: string; scheduled_at?: string; location?: string; duration_minutes?: number;
    notes_internal?: string; notes_client_facing?: string;
  }) => request<{ success: boolean; scheduled_event_id?: number }>('cases.php', 'POST', data, { action: 'event_request_decide', id: String(requestId) }),

  // Diligences
  activitiesList: (projectId: number) => request<CaseActivity[]>('cases.php', 'GET', undefined, { action: 'activities_list', id: String(projectId) }),
  activityCreate: (projectId: number, data: Partial<CaseActivity>) =>
    request<{ success: boolean; activity: CaseActivity }>('cases.php', 'POST', data, { action: 'activity_create', id: String(projectId) }),
  activityUpdate: (activityId: number, data: Partial<CaseActivity>) =>
    request('cases.php', 'PUT', data, { action: 'activity_update', id: String(activityId) }),
  activityDelete: (activityId: number) =>
    request('cases.php', 'DELETE', undefined, { action: 'activity_delete', id: String(activityId) }),

  /** Téléchargement document (auth via header → blob URL → nouvel onglet). */
  openDocument: async (docId: number, suggestedName?: string): Promise<void> => {
    const url = new URL(`${BASE}/cases.php`, window.location.origin);
    url.searchParams.set('action', 'document');
    url.searchParams.set('id', String(docId));
    const token = localStorage.getItem('bureau_token') ?? '';
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      const a = document.createElement('a');
      a.href = blobUrl; a.download = suggestedName || `doc-${docId}`; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  },

  /** Téléchargement PDF facture (auth via header → download direct). */
  downloadInvoicePdf: async (invoiceId: number, suggestedName?: string): Promise<void> => {
    const url = new URL(`${BASE}/cases.php`, window.location.origin);
    url.searchParams.set('action', 'invoice_pdf');
    url.searchParams.set('id', String(invoiceId));
    const token = localStorage.getItem('bureau_token') ?? '';
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl; a.download = suggestedName || `facture-${invoiceId}.pdf`; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  },

  // Signatures électroniques
  signaturesList:   (projectId: number) => request<CaseSignature[]>('cases.php', 'GET', undefined, { action: 'signatures_list', id: String(projectId) }),
  signatureCreate:  (projectId: number, data: { title: string; content_text: string; client_id: number; document_id?: number; expires_at?: string }) =>
    request<{ success: boolean; signature: CaseSignature }>('cases.php', 'POST', data, { action: 'signature_create', id: String(projectId) }),
  signatureCancel:  (sigId: number) => request('cases.php', 'POST', {}, { action: 'signature_cancel', id: String(sigId) }),
  signatureDelete:  (sigId: number) => request('cases.php', 'DELETE', undefined, { action: 'signature_delete', id: String(sigId) }),

  // Templates de dossier
  templatesList:    () => request<CaseTemplate[]>('cases.php', 'GET', undefined, { action: 'templates_list', id: '0' }),
  templateApply:    (templateId: number, data: { name?: string; client?: string; description?: string; case_number?: string; start_date?: string }) =>
    request<{
      success: boolean;
      project: Project;
      milestones_count: number;
      events_count: number;
      warnings?: { milestones?: string | null; events?: string | null; hint?: string };
    }>('cases.php', 'POST', data, { action: 'template_apply', id: String(templateId) }),
  templateCreate:   (data: Partial<CaseTemplate>) => request<{ success: boolean; template: CaseTemplate }>('cases.php', 'POST', data, { action: 'template_create', id: '0' }),
  templateUpdate:   (id: number, data: Partial<CaseTemplate>) => request('cases.php', 'PUT', data, { action: 'template_update', id: String(id) }),
  templateDelete:   (id: number) => request('cases.php', 'DELETE', undefined, { action: 'template_delete', id: String(id) }),
};

// ── Calendrier global ────────────────────────────────────────────────────────
export const calendarApi = {
  range: (from: string, to: string) =>
    request<{ from: string; to: string; events: CalendarEvent[] }>('calendar.php', 'GET', undefined, { from, to }),
};

// ── Finance (vue d'ensemble cabinet) ─────────────────────────────────────────
export const financeApi = {
  overview: () => request<FinanceOverview>('finance.php', 'GET'),
};

// ── Missions ─────────────────────────────────────────────────────────────────
export const missionsApi = {
  list:   () => request<Mission[]>('missions.php', 'GET', undefined, { action: 'list' }),
  create: (data: Partial<Mission>) => request('missions.php', 'POST', data, { action: 'create' }),
  update: (id: number, data: Partial<Mission>) => request('missions.php', 'PUT', data, { action: 'update', id: String(id) }),
  delete: (id: number) => request('missions.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
};

// ── HR ───────────────────────────────────────────────────────────────────────
export const hrApi = {
  /** Admin+ : tous les records. Agent : ses propres (l'API filtre par rôle). */
  list:    () => request<HrRecord[]>('hr.php', 'GET', undefined, { action: 'list' }),
  /** Force l'API à ne renvoyer QUE les records de l'utilisateur courant. */
  mine:    () => request<HrRecord[]>('hr.php', 'GET', undefined, { action: 'mine' }),
  /** Agent : soumettre sa propre demande (workflow obligatoire). */
  request: (data: {
    type: 'conge' | 'absence' | 'retard' | 'note';
    title: string;
    description?: string;
    start_date?: string;
    end_date?: string;
  }) => request<{ success: boolean; record: HrRecord }>('hr.php', 'POST', data, { action: 'request' }),
  /** Admin+ : créer un record pour soi ou pour autrui (peut directement définir le statut). */
  create:  (data: Partial<HrRecord>) =>
    request<{ success: boolean; record: HrRecord }>('hr.php', 'POST', data, { action: 'create' }),
  /** Admin valide/refuse (level='admin'), super_admin approuve/refuse finalement (level='super_admin'). */
  decide:  (id: number, payload: {
    level: 'admin' | 'super_admin';
    decision: 'valide' | 'refuse' | 'approuve';
    comment?: string;
  }) => request<{ success: boolean; record: HrRecord }>('hr.php', 'POST', payload, { action: 'decide', id: String(id) }),
  update:  (id: number, data: Partial<HrRecord>) => request('hr.php', 'PUT', data, { action: 'update', id: String(id) }),
  delete:  (id: number) => request('hr.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
  stats:   () => request<HrStats>('hr.php', 'GET', undefined, { action: 'stats' }),
};

// ── Accounting ───────────────────────────────────────────────────────────────
export const accountingApi = {
  list:   () => request<AccountingEntry[]>('accounting.php', 'GET', undefined, { action: 'list' }),
  create: (data: Partial<AccountingEntry>) => request('accounting.php', 'POST', data, { action: 'create' }),
  delete: (id: number) => request('accounting.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
  stats:  () => request<AccountingStats>('accounting.php', 'GET', undefined, { action: 'stats' }),
};

// ── Chat ─────────────────────────────────────────────────────────────────────
export const chatApi = {
  list:      (since?: number, channel = 'general') => request<ChatMessage[]>('messages.php', 'GET', undefined, { action: 'list', channel, ...(since ? { since: String(since) } : {}) }),
  send:      (content: string, channel = 'general') => request<{ message: ChatMessage }>('messages.php', 'POST', { content, channel }, { action: 'send' }),
  unreadDms: (sinceId?: number) => request<Record<string, number>>('messages.php', 'GET', undefined, { action: 'unread_dms', ...(sinceId ? { since_id: String(sinceId) } : {}) }),
};

export function dmChannel(myId: number, otherId: number): string {
  return 'dm:' + [myId, otherId].sort((a, b) => a - b).join('-');
}

// ── Feedback ─────────────────────────────────────────────────────────────────
export const feedbackApi = {
  list:   () => request<Feedback[]>('feedback.php', 'GET', undefined, { action: 'list' }),
  create: (data: Partial<Feedback>) => request('feedback.php', 'POST', data, { action: 'create' }),
  update: (id: number, status: string) => request('feedback.php', 'PUT', { status }, { action: 'update', id: String(id) }),
  delete: (id: number) => request('feedback.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
};

// ── Types ─────────────────────────────────────────────────────────────────────
/** Modules permission-aware (synchronisé avec scripts/bureau-api.cjs PERMISSION_KEYS et la sidebar). */
export const PERMISSION_KEYS = [
  'leads', 'assistant', 'projects', 'missions', 'clients', 'chat',
  'hr', 'accounting', 'feedback', 'job_offers', 'blog',
  'mailbox',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_LABELS: Record<PermissionKey, { label: string; group: 'agent' | 'admin' | 'super_admin'; description: string }> = {
  leads:      { label: "Demandes (leads)",       group: 'agent', description: "Voir, traiter et assigner les demandes du formulaire contact." },
  assistant:  { label: "Assistant IA agent",     group: 'agent', description: "Utiliser l'assistant Groq + base juridique interne." },
  projects:   { label: "Projets",                group: 'agent', description: "Voir les dossiers ; admin → créer/modifier/supprimer." },
  missions:   { label: "Mes missions",           group: 'agent', description: "Voir / mettre à jour le statut de ses missions." },
  clients:    { label: "Messages clients",       group: 'agent', description: "Lire et répondre aux messages de l'espace client." },
  chat:       { label: "Chat interne",           group: 'agent', description: "Discuter avec les autres membres du bureau." },
  hr:         { label: "Ressources humaines",    group: 'agent', description: "Demander congés/absences et suivre ses propres demandes. Admin+ : valider les demandes, gérer primes et notes." },
  accounting: { label: "Comptabilité",           group: 'admin', description: "Recettes, dépenses, rapports financiers." },
  feedback:   { label: "Retours clients",        group: 'admin', description: "Notes et avis des clients." },
  job_offers: { label: "Offres d'emploi",        group: 'admin', description: "Publier et modérer les offres affichées sur /recrutement." },
  blog:       { label: "Blog",                   group: 'admin', description: "Publier et modérer les articles affichés sur /blog." },
  mailbox:    { label: "Boîte mail LWS",         group: 'super_admin', description: "Consulter les boîtes mail professionnelles configurées." },
};

export type BureauUser = {
  id: number; username: string; full_name: string; email: string;
  practice_domains?: string | null;
  permissions?: string | null;     // CSV des modules autorisés ; null/vide/* = pas de restriction
  role: 'super_admin' | 'admin' | 'agent'; avatar?: string;
  first_login?: boolean; active?: boolean | number; last_login?: string; created_at?: string;
};

/** Vrai si l'utilisateur a accès au module donné. Super_admin a toujours tout. */
export function userHasPermission(user: BureauUser | null, perm: PermissionKey): boolean {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const raw = (user.permissions ?? '').trim();
  if (!raw || raw === '*') return true;
  const set = new Set(raw.split(/[,;\s]+/).filter(Boolean));
  if (set.has('*')) return true;
  return set.has(perm);
}

export type Project = {
  id: number; name: string; client: string; description?: string;
  status: 'en_cours'|'termine'|'en_pause'|'annule';
  priority: 'basse'|'normale'|'haute'|'urgente';
  budget: number; deadline?: string; progress: number;
  assigned_to?: number; agent_name?: string;
  case_number?: string | null;
  practice_area?: string | null;
  current_phase?: string | null;
  next_action?: string | null;
  next_action_date?: string | null;
  created_at: string; updated_at: string; missions?: Mission[];
};

// ── Dossiers (cases) — sous-collections d'un Project ─────────────────────────
export type CaseMilestone = {
  id: number;
  project_id: number;
  title: string;
  description?: string | null;
  due_date?: string | null;
  completed_at?: string | null;
  completed_by?: number | null;
  completed_by_name?: string | null;
  status: 'a_faire' | 'en_cours' | 'termine' | 'reporte' | 'annule';
  order_index: number;
  visible_to_client: boolean;
  created_at: string;
  updated_at?: string;
};

export type CaseEvent = {
  id: number;
  project_id: number;
  type: 'audience' | 'rdv' | 'echeance' | 'depot_pieces' | 'consultation' | 'autre';
  title: string;
  location?: string | null;
  scheduled_at: string;
  duration_minutes?: number | null;
  notes_internal?: string | null;
  notes_client_facing?: string | null;
  visible_to_client: boolean;
  completed_at?: string | null;
  outcome?: string | null;
  created_at: string;
  created_by_name?: string | null;
};

export type CaseDocument = {
  id: number;
  project_id?: number;
  title: string;
  kind: 'preuve' | 'contrat' | 'jugement' | 'conclusions' | 'expertise' | 'correspondance' | 'identite' | 'autre';
  description?: string | null;
  filename?: string | null;
  mime: string;
  size_bytes?: number | null;
  uploaded_by_user_id?: number | null;
  uploaded_by_client_id?: number | null;
  uploaded_by_name?: string | null;
  uploaded_by_kind?: 'cabinet' | 'client' | 'inconnu';
  visible_to_client: boolean;
  confidential: boolean;
  created_at: string;
};

export type CaseClient = {
  id: number;
  name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  active: boolean;
  role: string;
  added_at: string;
};

export type CaseDetail = {
  project: Project;
  milestones: CaseMilestone[];
  events: CaseEvent[];
  documents: CaseDocument[];
  clients: CaseClient[];
};

// ── Phase 2 : honoraires, paiements, demandes RDV, diligences ────────────────
export type CaseInvoice = {
  id: number;
  project_id: number;
  invoice_number?: string | null;
  title: string;
  description?: string | null;
  amount: number;
  currency: string;
  status: 'brouillon' | 'envoyee' | 'partiellement_payee' | 'payee' | 'annulee';
  due_date?: string | null;
  sent_at?: string | null;
  paid_amount: number;
  paid_at?: string | null;
  notes_internal?: string | null;
  notes_client?: string | null;
  visible_to_client: boolean;
  created_at: string;
  updated_at?: string;
};

export type CasePayment = {
  id: number;
  invoice_id: number;
  amount: number;
  paid_at: string;
  method: 'especes' | 'virement' | 'mobile_money' | 'cheque' | 'carte' | 'autre';
  reference?: string | null;
  notes?: string | null;
  created_at: string;
};

export type CaseEventRequest = {
  id: number;
  project_id: number;
  client_id: number;
  type: 'audience' | 'rdv' | 'consultation' | 'autre';
  title: string;
  proposed_date: string;
  alternative_date?: string | null;
  message?: string | null;
  status: 'pending' | 'accepted' | 'rescheduled' | 'refused' | 'cancelled';
  decided_at?: string | null;
  decided_by?: number | null;
  decided_by_name?: string | null;
  decided_message?: string | null;
  scheduled_event_id?: number | null;
  requester_name?: string | null;
  requester_email?: string | null;
  created_at: string;
};

export type CaseActivity = {
  id: number;
  project_id: number;
  user_id?: number | null;
  agent_name?: string | null;
  kind: 'consultation' | 'redaction' | 'audience' | 'recherche' | 'rdv' | 'expertise' | 'telephone' | 'email' | 'autre';
  title: string;
  description?: string | null;
  date: string;
  duration_minutes: number;
  billable: boolean;
  hourly_rate?: number | null;
  amount?: number | null;
  invoice_id?: number | null;
  created_at: string;
  updated_at?: string;
};

export type CaseSignature = {
  id: number;
  project_id: number;
  document_id?: number | null;
  client_id: number;
  client_name?: string | null;
  client_email?: string | null;
  title: string;
  content_text: string;
  status: 'pending' | 'signed' | 'refused' | 'cancelled' | 'expired';
  signed_at?: string | null;
  signed_name?: string | null;
  signed_hash?: string | null;
  refused_at?: string | null;
  refused_reason?: string | null;
  expires_at?: string | null;
  created_by?: number | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at?: string;
};

export type CaseTemplate = {
  id: number;
  name: string;
  description?: string | null;
  practice_area?: string | null;
  default_status: string;
  default_priority: string;
  milestones_json: Array<{ title: string; description?: string; due_offset_days: number; order_index: number; visible_to_client?: boolean }>;
  events_json: Array<{ type?: string; title: string; location?: string; scheduled_offset_days: number; duration_minutes?: number; visible_to_client?: boolean }>;
  is_active: boolean;
  created_by?: number | null;
  created_at: string;
  updated_at?: string;
};

export type CalendarEvent = {
  id: number;
  project_id: number;
  type: string;
  title: string;
  scheduled_at: string;
  duration_minutes?: number | null;
  location?: string | null;
  status?: string | null;
  visible_to_client?: boolean;
  case_name?: string | null;
  case_number?: string | null;
  case_priority?: string | null;
};

export type FinanceOverview = {
  kpis: {
    total_invoiced: number;
    total_collected: number;
    total_outstanding: number;
    overdue_count: number;
    overdue_amount: number;
  };
  overdue: Array<{
    id: number; project_id: number; invoice_number?: string | null; title: string;
    amount: number; paid_amount: number; remaining: number;
    currency: string; due_date: string; status: string;
    case_name?: string | null; case_number?: string | null;
    days_overdue: number;
  }>;
  trend: Array<{ label: string; amount: number }>;
  top_to_collect: Array<{ project_id: number; case_name?: string | null; case_number?: string | null; total: number; count: number }>;
  forecast: Array<{ month: string; amount: number }>;
};

export type ProjectStats = { total: number; en_cours: number; termine: number; en_pause: number; budget_total: number };

export type Mission = {
  id: number; title: string; description?: string;
  project_id?: number; project_name?: string;
  assigned_to: number; assignee_name?: string; assigned_by: number;
  status: 'a_faire'|'en_cours'|'termine'; due_date?: string; created_at: string;
};

export type HrStatus = 'en_attente' | 'valide_admin' | 'refuse_admin' | 'approuve' | 'refuse';

export type HrRecord = {
  id: number;
  user_id: number;
  employee_name?: string | null;
  employee_email?: string | null;
  type: 'conge' | 'absence' | 'retard' | 'prime' | 'note';
  title: string;
  description?: string | null;
  /** Date de référence (legacy — pour les anciens records sans start_date) */
  date: string;
  start_date?: string | null;
  end_date?: string | null;
  amount?: number | null;
  status: HrStatus;
  requires_workflow?: boolean;

  admin_decision?: 'valide' | 'refuse' | null;
  admin_decision_at?: string | null;
  admin_decision_by?: number | null;
  admin_decision_by_name?: string | null;
  admin_comment?: string | null;

  super_admin_decision?: 'approuve' | 'refuse' | null;
  super_admin_decision_at?: string | null;
  super_admin_decision_by?: number | null;
  super_admin_decision_by_name?: string | null;
  super_admin_comment?: string | null;

  created_by?: number | null;
  created_by_name?: string | null;
  submitted_at?: string | null;
  created_at: string;
  updated_at?: string;
};

export type HrStats = {
  total: number;
  en_attente: number;
  valide_admin: number;
  refuse_admin: number;
  approuve: number;
  refuse: number;
  total_conges: number;
  total_primes: number;
};

export type AccountingEntry = {
  id: number; type: 'recette'|'depense'; category: string;
  amount: number; description: string; project_id?: number; project_name?: string;
  date: string; created_by_name?: string; created_at: string;
};
export type AccountingStats = { recettes: number; depenses: number; solde: number; by_month: Array<{ month: string; type: string; total: number }> };

export type ChatMessage = { id: number; sender_id: number; sender_name: string; channel: string; content: string; created_at: string };

export type Feedback = {
  id: number; client_name: string; project_id?: number; project_name?: string;
  rating?: number; comment?: string; category: string;
  status: 'nouveau'|'traite'|'archive'; created_at: string;
};

// ── Leads (demandes de projet depuis le formulaire contact) ───────────────────
export type LeadDomain =
  | "juridique"
  | "fiscal"
  | "comptabilite"
  | "structuration"
  | "investissement"
  | "autre"
  | "non_classe";

export type Lead = {
  id: number;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  service?: string;
  domain?: LeadDomain;
  source?: string;
  budget?: string;
  timeline?: string;
  message: string;
  status: "nouveau" | "en_cours" | "converti" | "perdu" | "archive";
  assigned_to?: number;
  agent_name?: string;
  notes?: string;
  created_at: string;
  updated_at?: string;
};
export type LeadStats = {
  total: number;
  nouveau: number;
  en_cours: number;
  converti: number;
  perdu: number;
  archive: number;
};

export type LeadAssignee = {
  id: number;
  full_name: string;
  role: string;
  practice_domains?: string | null;
};

export const leadsApi = {
  list:      () => request<Lead[]>('leads.php', 'GET', undefined, { action: 'list' }),
  stats:     () => request<LeadStats>('leads.php', 'GET', undefined, { action: 'stats' }),
  assignees: (forDomain?: LeadDomain) =>
    request<LeadAssignee[]>(
      'leads.php',
      'GET',
      undefined,
      forDomain ? { action: 'assignees', for_domain: forDomain } : { action: 'assignees' },
    ),
  update:    (id: number, data: Partial<Lead>) => request('leads.php', 'PUT', data, { action: 'update', id: String(id) }),
  delete:    (id: number) => request('leads.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
};

// ── Clients (CRUD depuis le bureau — sélecteur dossier) ─────────────────────
export type ClientAccount = {
  id: number;
  name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  active: boolean;
  created_at: string;
};

export const clientsApi = {
  listAll: () => request<ClientAccount[]>('clients.php', 'GET', undefined, { action: 'list_all' }),
};

// ── Messages clients (accès depuis l'espace bureau — utilise le token bureau) ─
export type ClientConversation = {
  id: number; name: string; email: string; company?: string;
  unread: number; last_message_at: string; last_message?: string;
};
export type ClientMessage = {
  id: number; client_id: number; sender_type: 'client' | 'agent';
  sender_id?: number; agent_name?: string; content: string;
  is_read: number; created_at: string;
};

export const agentClientApi = {
  conversations: () => request<ClientConversation[]>('../client/messages.php', 'GET', undefined, { action: 'conversations' }),
  thread:        (clientId: number) => request<ClientMessage[]>('../client/messages.php', 'GET', undefined, { action: 'thread', client_id: String(clientId) }),
  reply:         (clientId: number, content: string) => request('../client/messages.php', 'POST', { client_id: clientId, content }, { action: 'agent_reply' }),
};

/** Assistant dossiers agents (Groq + base Markdown api/bureau/kb) — identifiant GROQ_API_KEY serveur */
export type AssistantMode = "assist" | "memo_defense" | "memo_litige";

export const assistantApi = {
  chat: (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    mode?: AssistantMode,
    dossier?: Record<string, string>,
  ) =>
    request<{
      success: boolean;
      message: string;
      reply?: string;
      model?: string;
      mode?: string;
      mode_requested?: string;
    }>("assistant.php", "POST", {
      messages,
      mode: mode ?? "assist",
      dossier,
    }),
};

// ── Offres d'emploi (publication depuis le bureau) ───────────────────────────
export type JobOfferAdmin = {
  id: number;
  slug: string;
  position_key?: string | null;
  title_fr: string;
  title_en?: string | null;
  summary_fr: string;
  summary_en?: string | null;
  meta_fr?: string | null;
  meta_en?: string | null;
  content_fr?: string | null;
  content_en?: string | null;
  contract_type?: string | null;
  location?: string | null;
  is_new: boolean;
  is_published: boolean;
  sort_order: number;
  published_at?: string | null;
  created_by?: number | null;
  created_at: string;
  updated_at?: string;
};

export type JobOfferInput = Omit<Partial<JobOfferAdmin>, "id" | "created_by" | "created_at" | "updated_at" | "published_at"> & {
  slug?: string;
};

export const jobOffersApi = {
  list:   () => request<JobOfferAdmin[]>("job_offers.php", "GET", undefined, { action: "list" }),
  create: (data: JobOfferInput) =>
    request<{ success: boolean; offer: JobOfferAdmin }>("job_offers.php", "POST", data, { action: "create" }),
  update: (id: number, data: JobOfferInput) =>
    request<{ success: boolean; offer: JobOfferAdmin }>("job_offers.php", "PUT", data, { action: "update", id: String(id) }),
  delete: (id: number) => request("job_offers.php", "DELETE", undefined, { action: "delete", id: String(id) }),
};

// ── Candidatures (job_applications) ──────────────────────────────────────────
export type JobApplication = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  city_country?: string | null;
  linkedin_url?: string | null;
  position_applied: string;
  contract_type: string;
  availability?: string | null;
  experience_years?: string | null;
  education_level?: string | null;
  languages?: string | null;
  motivation: string;
  application_mode?: 'offer' | 'profile_pool' | 'spontaneous' | null;
  job_offer_ref?: string | null;
  sought_role_title?: string | null;
  cv_original_name?: string | null;
  cv_mime?: string | null;
  cv_size_bytes?: number | null;
  locale?: 'fr' | 'en';
  consent_data_processing: boolean;
  status: 'nouveau' | 'examine' | 'entretien' | 'refuse' | 'embauche' | 'archive';
  notes?: string | null;
  assigned_to?: number | null;
  agent_name?: string | null;
  created_at: string;
  updated_at?: string;
};

export type JobApplicationStats = {
  total: number;
  nouveau: number;
  examine: number;
  entretien: number;
  refuse: number;
  embauche: number;
  archive: number;
};

export const applicationsApi = {
  list: () => request<JobApplication[]>('applications.php', 'GET', undefined, { action: 'list' }),
  stats: () => request<JobApplicationStats>('applications.php', 'GET', undefined, { action: 'stats' }),
  update: (id: number, data: Partial<Pick<JobApplication, 'status' | 'notes' | 'assigned_to'>>) =>
    request('applications.php', 'PUT', data, { action: 'update', id: String(id) }),
  delete: (id: number) => request('applications.php', 'DELETE', undefined, { action: 'delete', id: String(id) }),
  /** Ouvre le CV dans un nouvel onglet (auth via header, blob URL). */
  openCv: async (id: number, suggestedName?: string): Promise<void> => {
    const url = new URL(`${BASE}/applications.php`, window.location.origin);
    url.searchParams.set('action', 'cv');
    url.searchParams.set('id', String(id));
    const token = localStorage.getItem('bureau_token') ?? '';
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Erreur ${res.status} lors du téléchargement du CV`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = suggestedName || `cv-${id}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  },
};

// ── Mailbox LWS (super_admin) ────────────────────────────────────────────────
export type MailboxAccount = {
  id: number;
  label: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | null;
  active: boolean;
  created_at: string;
  updated_at?: string;
};

export type MailboxAccountInput = {
  label: string;
  email: string;
  password?: string;       // requis à la création, optionnel à l'update (ne change pas si vide)
  imap_host?: string;
  imap_port?: number;
  imap_secure?: boolean;
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  active?: boolean;
};

export type MailboxMessageSummary = {
  uid: number;
  seq?: number;
  date: string | null;
  subject: string;
  from_name: string;
  from_address: string;
  to: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  has_attachments?: boolean;
};

export type MailboxInbox = {
  folder: string;
  total: number;
  unseen: number;
  messages: MailboxMessageSummary[];
};

export type MailboxAttachment = {
  filename: string;
  contentType: string;
  size: number;
};

export type MailboxMessageDetail = MailboxMessageSummary & {
  message_id?: string | null;
  to_addresses?: string[];
  cc?: string;
  cc_addresses?: string[];
  text: string;
  html: string;
  attachments?: MailboxAttachment[];
};

export const mailboxApi = {
  accounts: () => request<{ accounts: MailboxAccount[] }>('mailbox.php', 'GET', undefined, { action: 'accounts' }),
  addAccount: (data: MailboxAccountInput) =>
    request<{ success: boolean; account: MailboxAccount }>('mailbox.php', 'POST', data, { action: 'add_account' }),
  updateAccount: (id: number, data: MailboxAccountInput) =>
    request<{ success: boolean; account: MailboxAccount }>('mailbox.php', 'PUT', data, { action: 'update_account', id: String(id) }),
  deleteAccount: (id: number) =>
    request('mailbox.php', 'DELETE', undefined, { action: 'delete_account', id: String(id) }),
  testConnection: (id: number) =>
    request<{ success: boolean; messages?: number; unseen?: number; error?: string }>(
      'mailbox.php', 'POST', undefined, { action: 'test_connection', id: String(id) },
    ),
  inbox: (id: number, opts?: { folder?: string; limit?: number }) =>
    request<MailboxInbox>('mailbox.php', 'GET', undefined, {
      action: 'inbox',
      id: String(id),
      ...(opts?.folder ? { folder: opts.folder } : {}),
      ...(opts?.limit ? { limit: String(opts.limit) } : {}),
    }),
  message: (id: number, uid: number, folder?: string) =>
    request<MailboxMessageDetail>('mailbox.php', 'GET', undefined, {
      action: 'message',
      id: String(id),
      uid: String(uid),
      ...(folder ? { folder } : {}),
    }),
  send: async (id: number, payload: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text?: string;
    html?: string;
    in_reply_to?: string;
    /** Secours si le déchiffrement échoue (mot de passe boîte LWS / Roundcube). */
    smtp_password?: string;
  }) => {
    const php = mailboxSendPhpUrl();
    if (php) {
      return mailboxLwsRequest<{
        success: boolean;
        messageId?: string;
        accepted?: string[];
        rejected?: string[];
      }>({
        action: "send",
        account_id: id,
        ...payload,
      });
    }
    return request<{ success: boolean; messageId?: string; accepted?: string[]; rejected?: string[] }>(
      "mailbox.php", "POST", payload, { action: "send", id: String(id) },
    );
  },
  testSmtp: async (id: number) => {
    const php = mailboxSendPhpUrl();
    if (php) {
      return mailboxLwsRequest<{
        success: boolean;
        host: string;
        results: Array<{ port: number; secure: boolean; ok: boolean; ms: number; error?: string }>;
        recommendation: string;
      }>({ action: "test_smtp", account_id: id });
    }
    return request<{
      success: boolean;
      host: string;
      results: Array<{ port: number; secure: boolean; ok: boolean; ms: number; error?: string }>;
      recommendation: string;
    }>("mailbox.php", "POST", undefined, { action: "test_smtp", id: String(id) });
  },
  /** Supprime un message : déplacé vers Corbeille si possible, sinon expunge définitif. */
  deleteMessage: (id: number, uid: number, opts?: { folder?: string; permanent?: boolean }) =>
    request<{ success: boolean; action: 'moved_to_trash' | 'expunged'; trash?: string }>(
      'mailbox.php', 'POST', undefined, {
        action: 'delete_message',
        id: String(id),
        uid: String(uid),
        ...(opts?.folder ? { folder: opts.folder } : {}),
        ...(opts?.permanent ? { permanent: 'true' } : {}),
      },
    ),
  /** Télécharge une pièce jointe (auth via header → blob URL → ouvre nouvel onglet). */
  openAttachment: async (
    accountId: number,
    uid: number,
    idx: number,
    suggestedName?: string,
    folder?: string,
  ): Promise<void> => {
    const url = new URL(`${BASE}/mailbox.php`, window.location.origin);
    url.searchParams.set('action', 'attachment');
    url.searchParams.set('id', String(accountId));
    url.searchParams.set('uid', String(uid));
    url.searchParams.set('idx', String(idx));
    if (folder) url.searchParams.set('folder', folder);
    const token = localStorage.getItem('bureau_token') ?? '';
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(t || `Erreur ${res.status}`);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = suggestedName || `piece-jointe-${idx + 1}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  },
};

// ── Articles blog (publication depuis le bureau) ─────────────────────────────
export type BlogImage = {
  id: number;
  filename?: string | null;
  mime: string;
  size_bytes?: number | null;
  created_at: string;
};

export type BlogArticleAdmin = {
  id: number;
  slug: string;
  title_fr: string;
  title_en?: string | null;
  excerpt_fr?: string | null;
  excerpt_en?: string | null;
  content_html_fr: string;
  content_html_en?: string | null;
  cover_image_url?: string | null;
  categories?: string | null;
  is_published: boolean;
  published_at?: string | null;
  author_name?: string | null;
  created_by?: number | null;
  created_at: string;
  updated_at?: string;
  images?: BlogImage[];
};

export type BlogArticleInput = Omit<Partial<BlogArticleAdmin>, "id" | "created_by" | "created_at" | "updated_at" | "published_at" | "images"> & {
  slug?: string;
};

export const blogArticlesApi = {
  list:   () => request<BlogArticleAdmin[]>("blog_articles.php", "GET", undefined, { action: "list" }),
  get:    (id: number) => request<BlogArticleAdmin>("blog_articles.php", "GET", undefined, { action: "get", id: String(id) }),
  create: (data: BlogArticleInput) =>
    request<{ success: boolean; article: BlogArticleAdmin }>("blog_articles.php", "POST", data, { action: "create" }),
  update: (id: number, data: BlogArticleInput) =>
    request<{ success: boolean; article: BlogArticleAdmin }>("blog_articles.php", "PUT", data, { action: "update", id: String(id) }),
  delete: (id: number) => request("blog_articles.php", "DELETE", undefined, { action: "delete", id: String(id) }),
  uploadImage: (
    articleId: number,
    payload: { filename: string; mime: string; data_base64: string; set_as_cover?: boolean },
  ) =>
    request<{ success: boolean; image: BlogImage; url: string }>(
      "blog_articles.php",
      "POST",
      payload,
      { action: "upload_image", id: String(articleId) },
    ),
  deleteImage: (articleId: number, imageId: number) =>
    request("blog_articles.php", "DELETE", undefined, {
      action: "delete_image",
      id: String(articleId),
      image_id: String(imageId),
    }),
};
