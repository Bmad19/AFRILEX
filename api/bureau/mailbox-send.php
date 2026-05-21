<?php
/**
 * Envoi mail bureau — exécuté sur LWS (dans dist/api/bureau/).
 * Le front appelle ce script en same-origin ; plus besoin de SMTP depuis Render.
 */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

// Apache/LWS : le header Authorization n’arrive souvent pas en PHP sans ceci
if (empty($_SERVER['HTTP_AUTHORIZATION'])) {
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $_SERVER['HTTP_AUTHORIZATION'] = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    } elseif (function_exists('apache_request_headers')) {
        $apacheHeaders = apache_request_headers();
        foreach ($apacheHeaders as $k => $v) {
            if (strcasecmp($k, 'Authorization') === 0) {
                $_SERVER['HTTP_AUTHORIZATION'] = $v;
                break;
            }
        }
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

foreach ([
    __DIR__ . '/../mailbox-relay.config.php',
    __DIR__ . '/../../mailbox-relay.config.php',
] as $relayCfg) {
    if (is_file($relayCfg)) {
        require_once $relayCfg;
        break;
    }
}

require_once __DIR__ . '/mailbox-lib.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['ping'] ?? '') === '1') {
    echo json_encode([
        'ok' => true,
        'service' => 'mailbox-send',
        'mode' => 'lws-direct',
        'supabase' => mailbox_cfg('SUPABASE_URL', '') !== '',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST uniquement'], JSON_UNESCAPED_UNICODE);
    exit;
}

// ── Mode legacy : relais Render → LWS (secret proxy) ─────────────────────────
$proxySecret = (string) mailbox_cfg('MAILBOX_PROXY_SECRET', '');
$givenProxy = $_SERVER['HTTP_X_MAILBOX_PROXY_SECRET'] ?? '';
if ($proxySecret !== '' && $givenProxy !== '' && hash_equals($proxySecret, $givenProxy)) {
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $user = (string) ($body['user'] ?? '');
    $pass = (string) ($body['pass'] ?? '');
    $matrix = [];
    if (is_array($body['attempts'] ?? null)) {
        foreach ($body['attempts'] as $a) {
            if (!is_array($a)) continue;
            $matrix[] = [
                'host' => (string) ($a['host'] ?? ''),
                'port' => (int) ($a['port'] ?? 465),
                'secure' => !empty($a['secure']),
            ];
        }
    }
    if (count($matrix) === 0 && $user !== '' && $pass !== '') {
        $fake = [
            'email' => $user,
            'smtp_host' => (string) ($body['smtp_host'] ?? ''),
            'smtp_port' => (int) ($body['smtp_port'] ?? 465),
            'smtp_secure' => !empty($body['smtp_secure']),
            'imap_host' => '',
            'password_enc' => '',
        ];
        // mot de passe en clair pour proxy Render
        $log = [];
        foreach (mailbox_build_matrix($fake) as $t) {
            $r = afrilex_smtp_attempt([
                'host' => $t['host'], 'port' => $t['port'], 'secure' => $t['secure'],
                'user' => $user, 'pass' => $pass,
                'verify_only' => !empty($body['verify_only']),
                'from' => (string) ($body['from'] ?? $user),
                'to' => $body['to'] ?? [], 'subject' => (string) ($body['subject'] ?? ''),
                'text' => (string) ($body['text'] ?? ''), 'html' => (string) ($body['html'] ?? ''),
            ]);
            $log[] = $r;
            if (!empty($r['ok'])) {
                echo json_encode(['success' => true, 'attempted' => $log, 'working' => ['host' => $r['host'], 'port' => $r['port'], 'secure' => $r['secure']]], JSON_UNESCAPED_UNICODE);
                exit;
            }
        }
        http_response_code(502);
        echo json_encode(['success' => false, 'error' => 'SMTP proxy échoué', 'attempted' => $log], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

// ── Mode bureau : Bearer token + action ─────────────────────────────────────
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$token = null;
if (preg_match('/^Bearer\s+(.+)$/i', $auth, $m)) {
    $token = trim($m[1]);
}
// Secours : token dans le corps JSON (si le proxy Apache supprime Authorization)
$bodyRaw = file_get_contents('php://input');
$bodyPre = $bodyRaw ? (json_decode($bodyRaw, true) ?? []) : [];
if (!$token && !empty($bodyPre['bureau_token'])) {
    $token = trim((string) $bodyPre['bureau_token']);
}

if (!$token) {
    http_response_code(401);
    echo json_encode(['error' => 'Non authentifié — reconnectez-vous au bureau'], JSON_UNESCAPED_UNICODE);
    exit;
}

$user = mailbox_auth_user($token);
if (!$user) {
    http_response_code(401);
    echo json_encode([
        'error' => 'Session expirée — déconnectez-vous puis reconnectez-vous au bureau',
        'hint' => 'Si le problème continue après reconnexion, vérifiez que dist/api/mailbox-relay.config.php est bien uploadé.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}
if (!mailbox_role_ok($user, 'super_admin')) {
    http_response_code(403);
    echo json_encode(['error' => 'Accès réservé au super administrateur'], JSON_UNESCAPED_UNICODE);
    exit;
}

$body = is_array($bodyPre) ? $bodyPre : [];
$action = (string) ($body['action'] ?? $_GET['action'] ?? '');

$accountId = (int) ($body['account_id'] ?? $_GET['account_id'] ?? $_GET['id'] ?? 0);
if ($accountId < 1) {
    http_response_code(400);
    echo json_encode(['error' => 'account_id requis'], JSON_UNESCAPED_UNICODE);
    exit;
}

$account = mailbox_load_account($accountId);
if (!$account) {
    http_response_code(404);
    echo json_encode(['error' => 'Compte mail introuvable'], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($action === 'test_smtp') {
    $smtpPass = !empty($body['smtp_password']) ? (string) $body['smtp_password'] : null;
    $r = mailbox_send_account($account, ['to' => [$account['email']], 'subject' => 'Test', 'text' => ''], true, $token, $smtpPass);
    if (!empty($r['ok'])) {
        $w = $r['working'] ?? [];
        echo json_encode([
            'success' => true,
            'host' => $w['host'] ?? 'mail',
            'via' => 'lws',
            'results' => [[
                'host' => $w['host'] ?? '', 'port' => $w['port'] ?? 0, 'secure' => !empty($w['secure']),
                'ok' => true, 'ms' => 0, 'via' => 'lws',
            ]],
            'recommendation' => '✅ SMTP LWS OK (' . ($w['host'] ?? '') . ':' . ($w['port'] ?? '') . ').',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
    http_response_code(502);
    echo json_encode([
        'success' => false,
        'error' => $r['error'] ?? 'Échec',
        'via' => 'lws',
        'attempted' => $r['attempted'] ?? [],
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($action === 'send') {
    $to = mailbox_sanitize_recipients($body['to'] ?? '');
    $cc = mailbox_sanitize_recipients($body['cc'] ?? '');
    $bcc = mailbox_sanitize_recipients($body['bcc'] ?? '');
    if (count($to) === 0) {
        http_response_code(400);
        echo json_encode(['error' => 'Au moins un destinataire (To) est requis.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $text = (string) ($body['text'] ?? '');
    $html = (string) ($body['html'] ?? '');
    if (trim($text) === '' && trim($html) === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Corps du message vide.'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $smtpPass = !empty($body['smtp_password']) ? (string) $body['smtp_password'] : null;
    $r = mailbox_send_account($account, [
        'to' => $to,
        'subject' => trim((string) ($body['subject'] ?? '')) ?: '(sans objet)',
        'text' => $text,
        'html' => $html,
    ], false, $token, $smtpPass);

    if (!empty($r['ok'])) {
        echo json_encode([
            'success' => true,
            'via' => 'lws',
            'messageId' => $r['messageId'] ?? null,
            'accepted' => $r['accepted'] ?? [],
            'rejected' => $r['rejected'] ?? [],
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(502);
    echo json_encode([
        'success' => false,
        'via' => 'lws',
        'error' => $r['error'] ?? 'Échec envoi',
        'attempted' => $r['attempted'] ?? [],
        'needs_smtp_password' => !empty($r['needs_smtp_password']),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'action invalide (send | test_smtp)'], JSON_UNESCAPED_UNICODE);
