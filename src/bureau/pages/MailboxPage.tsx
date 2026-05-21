import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAuth, hasRole } from "../BureauContext";
import {
  mailboxApi,
  type MailboxAccount,
  type MailboxAccountInput,
  type MailboxInbox,
  type MailboxMessageDetail,
  type MailboxMessageSummary,
} from "../api";

const inp = "w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white placeholder:text-white/45 focus:border-coral/50 focus:outline-none transition";
const lbl = "block text-[11px] font-bold uppercase tracking-wider text-white/40 mb-1.5";

const EMPTY_FORM: MailboxAccountInput = {
  label: "",
  email: "",
  password: "",
  imap_host: "",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "",
  smtp_port: 465,
  smtp_secure: true,
  active: true,
};

type ComposeState = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  in_reply_to?: string;
};
const EMPTY_COMPOSE: ComposeState = { to: "", cc: "", bcc: "", subject: "", text: "" };

function inferLwsHost(email: string) {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain ? `mail.${domain}` : "mail.lws-hosting.com";
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtSize(b?: number) {
  if (!b || b < 1024) return `${b ?? 0} o`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / (1024 * 1024)).toFixed(2)} Mo`;
}

function quoteOriginal(msg: MailboxMessageDetail): string {
  const date = msg.date ? new Date(msg.date).toLocaleString("fr-FR") : "(date inconnue)";
  const from = msg.from_name ? `${msg.from_name} <${msg.from_address}>` : msg.from_address;
  const body = msg.text || msg.html.replace(/<[^>]+>/g, "").trim() || "(corps vide)";
  return `\n\nLe ${date}, ${from} a écrit :\n` + body.split("\n").map((l) => `> ${l}`).join("\n");
}

export function MailboxPage() {
  const { user } = useAuth();
  const isSuperAdmin = hasRole(user, "super_admin");

  const [accounts, setAccounts] = useState<MailboxAccount[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [inbox, setInbox] = useState<MailboxInbox | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [openMessage, setOpenMessage] = useState<MailboxMessageDetail | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  const [accountModal, setAccountModal] = useState<"create" | "edit" | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [form, setForm] = useState<MailboxAccountInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [downloadingAttachIdx, setDownloadingAttachIdx] = useState<number | null>(null);

  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(EMPTY_COMPOSE);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Mode plein écran (cache la liste) + filtres avancés
  const [fullScreen, setFullScreen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyAttachments, setOnlyAttachments] = useState(false);
  const [period, setPeriod] = useState<"all" | "today" | "7d" | "30d">("all");
  const [deletingUid, setDeletingUid] = useState<number | null>(null);

  function loadAccounts() {
    setLoadingAccounts(true);
    mailboxApi.accounts()
      .then((r) => {
        setAccounts(r.accounts);
        if (r.accounts.length > 0 && activeId == null) setActiveId(r.accounts[0].id);
      })
      .catch(() => {})
      .finally(() => setLoadingAccounts(false));
  }

  function loadInbox(accountId: number) {
    setLoadingInbox(true);
    setInboxError(null);
    setInbox(null);
    setSelectedUid(null);
    setOpenMessage(null);
    mailboxApi.inbox(accountId, { limit: 100 })
      .then((data) => setInbox(data))
      .catch((e: unknown) => setInboxError(e instanceof Error ? e.message : "Erreur boîte mail"))
      .finally(() => setLoadingInbox(false));
  }

  function loadMessage(accountId: number, uid: number) {
    setLoadingMessage(true);
    setMessageError(null);
    setOpenMessage(null);
    mailboxApi.message(accountId, uid)
      .then((data) => setOpenMessage(data))
      .catch((e: unknown) => setMessageError(e instanceof Error ? e.message : "Lecture impossible"))
      .finally(() => setLoadingMessage(false));
  }

  useEffect(() => { loadAccounts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { if (activeId != null) { loadInbox(activeId); setFullScreen(false); } }, [activeId]);
  useEffect(() => {
    if (activeId != null && selectedUid != null) loadMessage(activeId, selectedUid);
    if (selectedUid == null) setFullScreen(false);
  }, [activeId, selectedUid]);

  const filteredMessages = useMemo<MailboxMessageSummary[]>(() => {
    if (!inbox) return [];
    const q = search.trim().toLowerCase();
    const now = Date.now();
    const periodMs = period === "today" ? 86400e3 : period === "7d" ? 7 * 86400e3 : period === "30d" ? 30 * 86400e3 : null;
    return inbox.messages.filter((m) => {
      if (onlyUnread && m.seen) return false;
      if (onlyAttachments && !m.has_attachments) return false;
      if (periodMs && m.date) {
        const t = new Date(m.date).getTime();
        if (!Number.isFinite(t) || now - t > periodMs) return false;
      }
      if (q && ![m.subject, m.from_name, m.from_address, m.to].some((v) => String(v ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [inbox, search, onlyUnread, onlyAttachments, period]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingAccountId(null);
    setAccountModal("create");
  }
  function openEdit(a: MailboxAccount) {
    setForm({
      label: a.label,
      email: a.email,
      password: "",
      imap_host: a.imap_host,
      imap_port: a.imap_port,
      imap_secure: a.imap_secure,
      smtp_host: a.smtp_host ?? "",
      smtp_port: a.smtp_port ?? 465,
      smtp_secure: a.smtp_secure ?? true,
      active: a.active,
    });
    setEditingAccountId(a.id);
    setAccountModal("edit");
  }

  function autofillFromEmail(email: string) {
    const host = inferLwsHost(email);
    setForm((f) => ({
      ...f,
      email,
      imap_host: f.imap_host || host,
      smtp_host: f.smtp_host || host,
    }));
  }

  async function saveAccount() {
    if (!form.label?.trim() || !form.email?.trim()) {
      alert("Label et email obligatoires.");
      return;
    }
    if (accountModal === "create" && !form.password) {
      alert("Mot de passe IMAP obligatoire à la création.");
      return;
    }
    setSaving(true);
    try {
      if (accountModal === "create") await mailboxApi.addAccount(form);
      else if (editingAccountId) await mailboxApi.updateAccount(editingAccountId, form);
      setAccountModal(null);
      loadAccounts();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Erreur d'enregistrement");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (!editingAccountId) {
      alert("Enregistrez d'abord le compte avant de tester.");
      return;
    }
    setTesting(true);
    try {
      const r = await mailboxApi.testConnection(editingAccountId);
      if (r.success) {
        alert(`✅ Connexion IMAP OK — ${r.messages ?? 0} message(s), ${r.unseen ?? 0} non lu(s).`);
      } else {
        alert(`❌ Échec : ${r.error ?? "raison inconnue"}`);
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Erreur");
    } finally {
      setTesting(false);
    }
  }

  async function testSmtp() {
    if (!editingAccountId) {
      alert("Enregistrez d'abord le compte avant de tester.");
      return;
    }
    setTestingSmtp(true);
    try {
      const r = await mailboxApi.testSmtp(editingAccountId);
      const lines = r.results.map((x) =>
        `  ${x.ok ? "✅" : "❌"} ${x.host ?? r.host}:${x.port} (${x.secure ? "SSL" : "STARTTLS"}) — ${x.ms}ms${x.error ? `\n     → ${x.error}` : ""}`,
      ).join("\n");
      const proxyLine = (r as { proxy_ok?: boolean }).proxy_ok ? "\n\n✅ Relais LWS (mailbox-send.php) opérationnel." : "";
      alert(`Test SMTP — ${r.host}\n\n${lines}${proxyLine}\n\n${r.recommendation}`);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Erreur");
    } finally {
      setTestingSmtp(false);
    }
  }

  async function deleteMessageByUid(uid: number, opts?: { skipConfirm?: boolean }) {
    if (activeId == null) return;
    if (!opts?.skipConfirm && !confirm("Supprimer ce message ?\nIl sera placé dans la Corbeille du serveur LWS (récupérable depuis Roundcube).")) return;
    setDeletingUid(uid);
    try {
      await mailboxApi.deleteMessage(activeId, uid);
      // Mise à jour optimiste de la liste locale
      setInbox((prev) => prev ? { ...prev, total: Math.max(0, prev.total - 1), messages: prev.messages.filter((m) => m.uid !== uid) } : prev);
      if (selectedUid === uid) {
        setSelectedUid(null);
        setOpenMessage(null);
        setFullScreen(false);
      }
    } catch (e: unknown) {
      alert(`Suppression impossible : ${e instanceof Error ? e.message : "erreur"}`);
    } finally {
      setDeletingUid(null);
    }
  }
  function deleteCurrentMessage() {
    if (openMessage) deleteMessageByUid(openMessage.uid);
  }

  async function downloadAttachment(idx: number) {
    if (!openMessage || activeId == null) return;
    const att = openMessage.attachments?.[idx];
    if (!att) return;
    setDownloadingAttachIdx(idx);
    try {
      await mailboxApi.openAttachment(activeId, openMessage.uid, idx, att.filename);
    } catch (e: unknown) {
      alert(`Téléchargement impossible : ${e instanceof Error ? e.message : "erreur"}`);
    } finally {
      setDownloadingAttachIdx(null);
    }
  }

  async function removeAccount(a: MailboxAccount) {
    if (!confirm(`Supprimer le compte « ${a.label} » (${a.email}) ?\nCela ne supprime pas les emails LWS, juste l'accès depuis le bureau.`)) return;
    try {
      await mailboxApi.deleteAccount(a.id);
      if (activeId === a.id) setActiveId(null);
      loadAccounts();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Erreur");
    }
  }

  function openComposeNew() {
    if (accounts.length === 0) {
      alert("Configurez d'abord un compte mail.");
      return;
    }
    setCompose(EMPTY_COMPOSE);
    setSendResult(null);
    setComposeOpen(true);
  }

  function openReply(m: MailboxMessageDetail, mode: "reply" | "reply_all" | "forward") {
    const account = accounts.find((a) => a.id === activeId);
    const myEmail = account?.email.toLowerCase() ?? "";
    const senderAddress = m.from_address;

    if (mode === "forward") {
      setCompose({
        to: "",
        cc: "",
        bcc: "",
        subject: `Tr : ${m.subject.replace(/^(Tr|Fwd?|TR)\s*:\s*/i, "")}`,
        text: `\n\n---------- Message transféré ----------\n${quoteOriginal(m).trim()}`,
      });
    } else {
      const toList = [senderAddress];
      const ccList: string[] = [];
      if (mode === "reply_all") {
        for (const addr of [...(m.to_addresses ?? []), ...(m.cc_addresses ?? [])]) {
          if (!addr) continue;
          const low = addr.toLowerCase();
          if (low === myEmail) continue;
          if (toList.includes(addr) || ccList.includes(addr)) continue;
          ccList.push(addr);
        }
      }
      setCompose({
        to: toList.join(", "),
        cc: ccList.join(", "),
        bcc: "",
        subject: `Re : ${m.subject.replace(/^(Re|RE)\s*:\s*/i, "")}`,
        text: quoteOriginal(m),
        in_reply_to: m.message_id || undefined,
      });
    }
    setSendResult(null);
    setComposeOpen(true);
  }

  async function sendCompose() {
    if (activeId == null) return;
    if (!compose.to.trim()) {
      setSendResult({ kind: "err", text: "Au moins un destinataire (À) est requis." });
      return;
    }
    if (!compose.subject.trim() && !confirm("Envoyer sans objet ?")) return;
    if (!compose.text.trim()) {
      setSendResult({ kind: "err", text: "Le corps du message est vide." });
      return;
    }
    setSending(true);
    setSendResult(null);
    try {
      const doSend = (smtpPassword?: string) =>
        mailboxApi.send(activeId, {
          to: compose.to,
          cc: compose.cc,
          bcc: compose.bcc,
          subject: compose.subject,
          text: compose.text,
          in_reply_to: compose.in_reply_to,
          ...(smtpPassword ? { smtp_password: smtpPassword } : {}),
        });

      let r = await doSend();
      if (r.success) {
        setSendResult({ kind: "ok", text: `Envoyé à ${r.accepted?.join(", ") ?? compose.to}` });
        setTimeout(() => setComposeOpen(false), 1200);
      } else {
        setSendResult({ kind: "err", text: "Échec d'envoi (réponse non OK)" });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Échec d'envoi";
      const needsPwd = /needs_smtp_password|Déchiffrement|mot de passe/i.test(msg);
      if (needsPwd) {
        const pwd = window.prompt(
          "Mot de passe SMTP de ce compte (identique à Roundcube / webmail LWS).\n" +
            "Il sera enregistré à nouveau pour les prochains envois.",
        );
        if (pwd?.trim()) {
          try {
            const r2 = await mailboxApi.send(activeId, {
              to: compose.to,
              cc: compose.cc,
              bcc: compose.bcc,
              subject: compose.subject,
              text: compose.text,
              in_reply_to: compose.in_reply_to,
              smtp_password: pwd.trim(),
            });
            if (r2.success) {
              try {
                await mailboxApi.updateAccount(activeId, { password: pwd.trim() });
              } catch { /* envoi OK même si re-enregistrement échoue */ }
              setSendResult({ kind: "ok", text: `Envoyé à ${r2.accepted?.join(", ") ?? compose.to}` });
              setTimeout(() => setComposeOpen(false), 1200);
              setSending(false);
              return;
            }
          } catch (e2: unknown) {
            setSendResult({ kind: "err", text: e2 instanceof Error ? e2.message : "Échec après saisie du mot de passe" });
            setSending(false);
            return;
          }
        }
      }
      setSendResult({ kind: "err", text: msg });
    } finally {
      setSending(false);
    }
  }

  if (!isSuperAdmin) {
    return (
      <div className="rounded-2xl border border-coral/20 bg-coral/5 p-6">
        <p className="text-sm text-coral">Accès réservé au super administrateur.</p>
      </div>
    );
  }

  const activeAccount = accounts.find((a) => a.id === activeId);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Boîte mail LWS</h1>
          <p className="text-sm text-white/40 mt-0.5">
            Consultez et envoyez les emails depuis tous les comptes professionnels créés sur LWS. Mots de passe chiffrés AES-256-GCM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {accounts.length > 0 && (
            <button onClick={openComposeNew}
              className="rounded-xl bg-violet px-5 py-2.5 text-sm font-bold text-ink hover:brightness-110 transition active:scale-95">
              ✏️ Composer
            </button>
          )}
          <button onClick={openCreate}
            className="rounded-xl bg-coral px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 transition active:scale-95">
            + Compte mail
          </button>
        </div>
      </div>

      {loadingAccounts ? (
        <div className="py-16 text-center text-white/48 text-sm">Chargement…</div>
      ) : accounts.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.04] text-2xl">📭</div>
          <p className="text-sm text-white/55">Aucun compte mail configuré.</p>
          <p className="text-xs text-white/40 mt-2 max-w-md mx-auto">
            Cliquez « + Compte mail » et renseignez l'email LWS + mot de passe IMAP. Hôte par défaut : <code className="text-white/65">mail.&lt;votre-domaine&gt;</code>.
          </p>
        </div>
      ) : (
        <>
          {/* Onglets comptes */}
          <div className="flex flex-wrap items-center gap-2">
            {accounts.map((a) => (
              <div
                key={a.id}
                className={`flex items-center gap-1 rounded-full border transition ${
                  a.id === activeId
                    ? "border-coral/35 bg-coral/15"
                    : "border-white/10 bg-white/[0.03] hover:border-white/25"
                }`}
              >
                <button
                  onClick={() => setActiveId(a.id)}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-bold transition ${
                    a.id === activeId ? "text-coral" : "text-white/65 hover:text-white"
                  }`}
                >
                  <span>{a.label}</span>
                  <span className="text-[10px] font-normal opacity-65">{a.email}</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); openEdit(a); }}
                  className="px-2 py-2 text-white/55 hover:text-white transition"
                  title="Modifier le compte"
                  aria-label={`Modifier ${a.label}`}
                >⚙</button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeAccount(a); }}
                  className="pr-3 py-2 text-coral/65 hover:text-coral transition"
                  title="Supprimer le compte"
                  aria-label={`Supprimer ${a.label}`}
                >🗑</button>
              </div>
            ))}
          </div>

          {/* Filtres rapides */}
          {!fullScreen && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setOnlyUnread((v) => !v)}
                className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                  onlyUnread ? "border-coral/40 bg-coral/15 text-coral" : "border-white/12 bg-white/[0.03] text-white/65 hover:text-white"
                }`}
                title="Non lus uniquement"
              >● Non lus{inbox?.unseen ? ` (${inbox.unseen})` : ""}</button>
              <button
                onClick={() => setOnlyAttachments((v) => !v)}
                className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                  onlyAttachments ? "border-violet/40 bg-violet/15 text-violet" : "border-white/12 bg-white/[0.03] text-white/65 hover:text-white"
                }`}
                title="Messages avec pièces jointes"
              >📎 Pièces jointes</button>
              <div className="flex rounded-full border border-white/12 bg-white/[0.03] overflow-hidden">
                {([
                  { v: "all", l: "Tout" },
                  { v: "today", l: "Aujourd'hui" },
                  { v: "7d", l: "7 jours" },
                  { v: "30d", l: "30 jours" },
                ] as const).map((p) => (
                  <button key={p.v} onClick={() => setPeriod(p.v)}
                    className={`px-3 py-1.5 text-[11px] font-bold transition ${period === p.v ? "bg-white/12 text-white" : "text-white/55 hover:text-white"}`}>
                    {p.l}
                  </button>
                ))}
              </div>
              {(onlyUnread || onlyAttachments || period !== "all" || search) && (
                <button
                  onClick={() => { setOnlyUnread(false); setOnlyAttachments(false); setPeriod("all"); setSearch(""); }}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] text-white/55 hover:text-white"
                >✕ Effacer filtres</button>
              )}
            </div>
          )}

          {/* Boîte */}
          <div className={`grid gap-4 ${fullScreen ? "" : "lg:grid-cols-[minmax(240px,300px)_1fr]"}`}>
            <div className={`rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden flex flex-col max-h-[85vh] ${fullScreen ? "hidden" : ""}`}>
              <div className="border-b border-white/[0.06] p-3 flex items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filtrer (sujet, expéditeur…)"
                  className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white placeholder:text-white/40 focus:border-coral/40 focus:outline-none"
                />
                <button
                  onClick={() => activeId != null && loadInbox(activeId)}
                  className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/65 hover:bg-white/[0.08] hover:text-white transition"
                  title="Actualiser"
                >↻</button>
              </div>

              <div className="flex-1 overflow-y-auto styled-scrollbar">
                {loadingInbox ? (
                  <div className="py-16 text-center text-white/48 text-xs">Connexion IMAP…</div>
                ) : inboxError ? (
                  <div className="p-4 text-xs text-coral">{inboxError}</div>
                ) : filteredMessages.length === 0 ? (
                  <div className="py-16 text-center text-white/48 text-xs">
                    {inbox && inbox.messages.length === 0 ? "Boîte vide." : "Aucun résultat."}
                  </div>
                ) : (
                  <ul className="divide-y divide-white/[0.04]">
                    {filteredMessages.map((m) => (
                      <li key={m.uid} className="group relative">
                        <button
                          onClick={() => setSelectedUid(m.uid)}
                          className={`w-full text-left px-3 py-2 pr-9 transition hover:bg-white/[0.03] ${
                            m.uid === selectedUid ? "bg-coral/[0.07]" : ""
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${m.seen ? "bg-white/20" : "bg-coral"}`} aria-hidden />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <p className={`truncate text-xs ${m.seen ? "text-white/75" : "text-white font-semibold"}`}>
                                  {m.from_name || m.from_address || "?"}
                                </p>
                                <span className="text-[10px] text-white/40 whitespace-nowrap">{fmtDate(m.date)}</span>
                              </div>
                              <p className={`mt-0.5 truncate text-[11px] ${m.seen ? "text-white/55" : "text-white/85 font-medium"} flex items-center gap-1`}>
                                {m.has_attachments && <span className="text-violet/85 shrink-0" title="Pièce jointe">📎</span>}
                                <span className="truncate">{m.subject}</span>
                              </p>
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); deleteMessageByUid(m.uid); }}
                          disabled={deletingUid === m.uid}
                          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-coral/0 group-hover:text-coral/80 hover:bg-coral/15 hover:text-coral transition disabled:opacity-50"
                          title="Supprimer ce message"
                          aria-label="Supprimer ce message"
                        >
                          {deletingUid === m.uid ? "…" : "🗑"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {inbox && (
                <div className="border-t border-white/[0.06] px-4 py-2 text-[10px] text-white/45 flex items-center justify-between">
                  <span>{inbox.folder} · {inbox.total} message(s) · {inbox.unseen} non lu(s)</span>
                  <span>{filteredMessages.length} affiché(s)</span>
                </div>
              )}
            </div>

            <div className={`rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden flex flex-col min-h-[600px] ${fullScreen ? "max-h-[92vh]" : "max-h-[85vh]"}`}>
              {selectedUid == null ? (
                <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.04] text-2xl">✉️</div>
                  <p className="text-sm text-white/55">Sélectionnez un message à gauche pour le lire,</p>
                  <p className="text-sm text-white/55">ou cliquez « Composer » pour écrire un nouveau message.</p>
                </div>
              ) : loadingMessage ? (
                <div className="flex-1 flex items-center justify-center text-xs text-white/45">Chargement…</div>
              ) : messageError ? (
                <div className="flex-1 p-6 text-sm text-coral">{messageError}</div>
              ) : openMessage ? (
                <>
                  <div className="border-b border-white/[0.06] p-5">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <h2 className="font-display text-lg font-bold text-white leading-tight">{openMessage.subject}</h2>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => openReply(openMessage, "reply")}
                          className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-1.5 text-xs font-bold text-coral hover:bg-coral/20 transition"
                          title="Répondre"
                        >↩ Répondre</button>
                        <button
                          onClick={() => openReply(openMessage, "reply_all")}
                          className="rounded-lg border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-bold text-white/75 hover:bg-white/[0.07] transition"
                          title="Répondre à tous"
                        >↩↩ Tous</button>
                        <button
                          onClick={() => openReply(openMessage, "forward")}
                          className="rounded-lg border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-bold text-white/75 hover:bg-white/[0.07] transition"
                          title="Transférer"
                        >→ Tr</button>
                        <button
                          onClick={() => setFullScreen((v) => !v)}
                          className="rounded-lg border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-bold text-white/75 hover:bg-white/[0.07] transition"
                          title={fullScreen ? "Réafficher la liste" : "Mode plein écran (lecture confortable)"}
                        >{fullScreen ? "⤡ Réduire" : "⤢ Plein écran"}</button>
                        <button
                          onClick={() => deleteCurrentMessage()}
                          disabled={deletingUid === openMessage.uid}
                          className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-1.5 text-xs font-bold text-coral hover:bg-coral/20 transition disabled:opacity-50"
                          title="Supprimer ce message (placé en Corbeille si possible)"
                        >{deletingUid === openMessage.uid ? "…" : "🗑 Supprimer"}</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr] gap-y-1.5 gap-x-3 text-xs">
                      <span className="text-white/40 uppercase tracking-wider">De</span>
                      <span className="text-white/85">
                        <span className="font-semibold">{openMessage.from_name || openMessage.from_address}</span>
                        {openMessage.from_address && openMessage.from_name ? <span className="text-white/45"> &lt;{openMessage.from_address}&gt;</span> : null}
                      </span>
                      <span className="text-white/40 uppercase tracking-wider">À</span>
                      <span className="text-white/65">{openMessage.to || "—"}</span>
                      {openMessage.cc ? (<>
                        <span className="text-white/40 uppercase tracking-wider">Cc</span>
                        <span className="text-white/65">{openMessage.cc}</span>
                      </>) : null}
                      <span className="text-white/40 uppercase tracking-wider">Date</span>
                      <span className="text-white/65">{fmtDate(openMessage.date)}</span>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto styled-scrollbar">
                    {openMessage.attachments && openMessage.attachments.length > 0 && (
                      <div className="border-b border-white/[0.06] px-5 py-3 bg-white/[0.02]">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-white/45 mb-2">
                          {openMessage.attachments.length} pièce{openMessage.attachments.length > 1 ? "s" : ""} jointe{openMessage.attachments.length > 1 ? "s" : ""}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {openMessage.attachments.map((att, i) => {
                            const isLoading = downloadingAttachIdx === i;
                            return (
                              <button
                                key={`${att.filename}-${i}`}
                                onClick={() => downloadAttachment(i)}
                                disabled={isLoading}
                                className="group flex items-center gap-2 rounded-lg border border-violet/25 bg-violet/[0.08] px-3 py-1.5 text-xs text-white/85 hover:bg-violet/[0.18] hover:border-violet/40 transition disabled:opacity-50"
                                title={`Télécharger ${att.filename} (${att.contentType})`}
                              >
                                {isLoading ? (
                                  <span className="inline-block h-3 w-3 animate-spin rounded-full border border-violet/40 border-t-violet" />
                                ) : (
                                  <span>📎</span>
                                )}
                                <span className="truncate max-w-[180px]" title={att.filename}>{att.filename}</span>
                                <span className="text-white/45 whitespace-nowrap">{fmtSize(att.size)}</span>
                                <span className="text-violet/85 group-hover:text-violet ml-1">↓</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {openMessage.html ? (
                      <iframe
                        title={openMessage.subject}
                        srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
                          html,body{background:#263a34!important;color:#f1f5f9;margin:0;padding:16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
                          body *{max-width:100%!important;}
                          img{height:auto;background:transparent;}
                          a{color:#a7d4c5;}
                          table{max-width:100%!important;background:transparent!important;}
                          /* Adoucit le contraste pour les emails qui forcent un fond clair (newsletters) */
                          [bgcolor="#ffffff"],[bgcolor="#FFFFFF"],[style*="background:#fff"],[style*="background-color:#fff"]{background:transparent!important;color:#f1f5f9!important;}
                        </style></head><body>${openMessage.html}</body></html>`}
                        sandbox="allow-same-origin allow-popups"
                        className="w-full h-full min-h-[60vh]"
                        style={{ background: "#263a34" }}
                      />
                    ) : openMessage.text ? (
                      <pre className="whitespace-pre-wrap p-6 text-[15px] leading-7 font-sans text-white/90" style={{ minHeight: "60vh" }}>{openMessage.text}</pre>
                    ) : (
                      <p className="p-5 text-sm text-white/55 italic">
                        (Aucun corps texte/HTML lisible — le message contient peut-être uniquement des pièces jointes ou un format binaire.)
                      </p>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </>
      )}

      {/* Modal compte */}
      <AnimatePresence>
        {accountModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
            onClick={(e) => e.target === e.currentTarget && setAccountModal(null)}>
            <motion.div initial={{ scale: 0.95, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }}
              className="my-8 w-full max-w-2xl rounded-3xl border border-white/10 bg-[#0f1012] shadow-2xl overflow-hidden">
              <div className="border-b border-white/[0.07] px-6 py-4 flex items-center justify-between">
                <h3 className="font-display text-lg font-bold text-white">
                  {accountModal === "create" ? "Nouveau compte mail LWS" : "Modifier le compte mail"}
                </h3>
                <button onClick={() => setAccountModal(null)} className="text-white/55 hover:text-white transition text-xl">×</button>
              </div>

              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>Libellé *</label>
                    <input value={form.label ?? ""} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} className={inp} placeholder="Contact général" />
                  </div>
                  <div>
                    <label className={lbl}>Email LWS *</label>
                    <input type="email" value={form.email ?? ""} onChange={(e) => autofillFromEmail(e.target.value)} className={inp} placeholder="info@afrilexconseil.com" />
                  </div>
                </div>

                <div>
                  <label className={lbl}>Mot de passe IMAP/SMTP {accountModal === "edit" ? "(laisser vide pour ne pas changer)" : "*"}</label>
                  <input type="password" autoComplete="new-password" value={form.password ?? ""} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className={inp} />
                  <p className="text-[11px] text-white/40 mt-1">Stocké chiffré AES-256-GCM. Côté LWS : panneau Webmail / Comptes mail → mot de passe associé à l'adresse.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label className={lbl}>Hôte IMAP (réception)</label>
                    <input value={form.imap_host ?? ""} onChange={(e) => setForm((f) => ({ ...f, imap_host: e.target.value }))} className={inp} placeholder="mail.afrilexconseil.com" />
                  </div>
                  <div>
                    <label className={lbl}>Port IMAP</label>
                    <input type="number" value={String(form.imap_port ?? 993)} onChange={(e) => setForm((f) => ({ ...f, imap_port: +e.target.value }))} className={inp} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-white/80">
                  <input type="checkbox" checked={!!form.imap_secure} onChange={(e) => setForm((f) => ({ ...f, imap_secure: e.target.checked }))} className="h-4 w-4 rounded border-white/20" />
                  IMAP sécurisé (SSL/TLS — recommandé port 993)
                </label>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label className={lbl}>Hôte SMTP (envoi)</label>
                    <input value={form.smtp_host ?? ""} onChange={(e) => setForm((f) => ({ ...f, smtp_host: e.target.value }))} className={inp} placeholder="mail.afrilexconseil.com" />
                  </div>
                  <div>
                    <label className={lbl}>Port SMTP</label>
                    <input type="number" value={String(form.smtp_port ?? 465)} onChange={(e) => setForm((f) => ({ ...f, smtp_port: +e.target.value }))} className={inp} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-white/80">
                  <input type="checkbox" checked={!!form.smtp_secure} onChange={(e) => setForm((f) => ({ ...f, smtp_secure: e.target.checked }))} className="h-4 w-4 rounded border-white/20" />
                  SMTP sécurisé (SSL/TLS — recommandé port 465)
                </label>

                {accountModal === "edit" && (
                  <label className="flex items-center gap-2 text-sm text-white/80">
                    <input type="checkbox" checked={!!form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-white/20" />
                    Compte actif
                  </label>
                )}
              </div>

              <div className="border-t border-white/[0.07] px-6 py-4 flex flex-wrap gap-3">
                <button onClick={() => setAccountModal(null)} className="flex-1 rounded-xl border border-white/10 py-3 text-sm text-white/50 hover:text-white transition">
                  Annuler
                </button>
                {accountModal === "edit" && (
                  <>
                    <button onClick={testConnection} disabled={testing} className="rounded-xl border border-violet/20 bg-violet/10 px-4 py-3 text-sm font-bold text-violet hover:bg-violet/20 transition disabled:opacity-40">
                      {testing ? "…" : "Tester IMAP"}
                    </button>
                    <button onClick={testSmtp} disabled={testingSmtp} className="rounded-xl border border-lime/25 bg-lime/10 px-4 py-3 text-sm font-bold text-lime hover:bg-lime/20 transition disabled:opacity-40">
                      {testingSmtp ? "…" : "Tester SMTP"}
                    </button>
                  </>
                )}
                <button onClick={saveAccount} disabled={saving} className="flex-1 rounded-xl bg-coral py-3 text-sm font-bold text-white hover:brightness-110 transition disabled:opacity-40">
                  {saving ? "Enregistrement…" : (accountModal === "create" ? "Créer le compte" : "Enregistrer")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modal Composer */}
      <AnimatePresence>
        {composeOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto"
            onClick={(e) => e.target === e.currentTarget && setComposeOpen(false)}>
            <motion.div initial={{ scale: 0.96, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96 }}
              className="my-8 w-full max-w-3xl rounded-3xl border border-white/10 bg-[#0f1012] shadow-2xl overflow-hidden">
              <div className="border-b border-white/[0.07] px-6 py-4 flex items-center justify-between">
                <h3 className="font-display text-lg font-bold text-white">
                  {compose.in_reply_to ? "Réponse" : (compose.subject.startsWith("Tr ") ? "Transférer" : "Nouveau message")}
                </h3>
                <button onClick={() => setComposeOpen(false)} className="text-white/55 hover:text-white transition text-xl">×</button>
              </div>

              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-xs text-white/55">
                  De : <span className="font-semibold text-white/85">{activeAccount?.label ?? "—"}</span>
                  <span className="text-white/45"> &lt;{activeAccount?.email ?? "—"}&gt;</span>
                </div>

                <div>
                  <label className={lbl}>À * <span className="font-normal text-white/35">(plusieurs adresses séparées par virgule)</span></label>
                  <input value={compose.to} onChange={(e) => setCompose((c) => ({ ...c, to: e.target.value }))} className={inp} placeholder="prenom@exemple.com, autre@exemple.com" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>Cc</label>
                    <input value={compose.cc} onChange={(e) => setCompose((c) => ({ ...c, cc: e.target.value }))} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Cci (Bcc)</label>
                    <input value={compose.bcc} onChange={(e) => setCompose((c) => ({ ...c, bcc: e.target.value }))} className={inp} />
                  </div>
                </div>

                <div>
                  <label className={lbl}>Objet</label>
                  <input value={compose.subject} onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))} className={inp} />
                </div>

                <div>
                  <label className={lbl}>Message *</label>
                  <textarea
                    rows={14}
                    value={compose.text}
                    onChange={(e) => setCompose((c) => ({ ...c, text: e.target.value }))}
                    className={inp + " resize-y min-h-[260px] font-mono text-xs"}
                    placeholder="Bonjour,&#10;&#10;…"
                  />
                  <p className="text-[11px] text-white/40 mt-1">Texte brut. Pour réponse : le message original est cité au format quoté ci-dessous.</p>
                </div>

                {sendResult && (
                  <div className={`rounded-xl px-4 py-3 text-sm ${
                    sendResult.kind === "ok"
                      ? "border border-lime/30 bg-lime/10 text-lime"
                      : "border border-coral/30 bg-coral/10 text-coral"
                  }`}>
                    {sendResult.text}
                  </div>
                )}
              </div>

              <div className="border-t border-white/[0.07] px-6 py-4 flex gap-3">
                <button onClick={() => setComposeOpen(false)} className="flex-1 rounded-xl border border-white/10 py-3 text-sm text-white/50 hover:text-white transition">
                  Annuler
                </button>
                <button onClick={sendCompose} disabled={sending} className="flex-1 rounded-xl bg-coral py-3 text-sm font-bold text-white hover:brightness-110 transition disabled:opacity-40">
                  {sending ? "Envoi en cours (peut prendre 1–2 min)…" : "✈ Envoyer"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
