<?php
/**
 * Bibliothèque relais mail LWS (SMTP + Supabase + déchiffrement mots de passe).
 * Config : ../mailbox-relay.config.php (généré au build, non accessible via HTTP).
 */

function mailbox_cfg(string $key, $default = '') {
    return defined($key) ? constant($key) : $default;
}

function mailbox_key_variants(): array {
    $keys = [];
    $add = function ($key) use (&$keys) {
        if (is_string($key) && strlen($key) === 32) {
            $keys[] = $key;
        }
    };

    $raw = (string) mailbox_cfg('MAILBOX_ENCRYPTION_KEY', '');
    if ($raw !== '') {
        if (preg_match('/^[0-9a-f]{64}$/i', $raw)) {
            $bin = hex2bin($raw);
            if ($bin !== false) {
                $add($bin);
            }
        } else {
            $add(hash('sha256', $raw, true));
        }
    }
    $srk = (string) mailbox_cfg('SUPABASE_SERVICE_ROLE_KEY', '');
    if ($srk !== '') {
        $add(hash('sha256', 'afrilex-mailbox|' . $srk, true));
    }
    return $keys;
}

function mailbox_decrypt(string $blob): string {
    $parts = explode(':', $blob, 3);
    if (count($parts) !== 3) {
        throw new RuntimeException('Format password_enc invalide');
    }
    $iv = base64_decode($parts[0], true);
    $tag = base64_decode($parts[1], true);
    $enc = base64_decode($parts[2], true);
    if ($iv === false || $tag === false || $enc === false) {
        throw new RuntimeException('Décodage base64 impossible');
    }
    foreach (mailbox_key_variants() as $key) {
        $plain = openssl_decrypt($enc, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($plain !== false && $plain !== '') {
            return $plain;
        }
    }
    throw new RuntimeException('Déchiffrement local impossible');
}

/** @return array{password: ?string, http: int, error: string} */
function mailbox_fetch_password_from_render(int $accountId, string $bearer): array {
    $fail = ['password' => null, 'http' => 0, 'error' => ''];
    $api = trim((string) mailbox_cfg('BUREAU_API_URL', ''));
    if ($api === '' || $bearer === '') {
        $fail['error'] = 'BUREAU_API_URL ou token manquant';
        return $fail;
    }
    $url = rtrim($api, '/') . '/mailbox.php?action=mail_password&id=' . $accountId;
    $payload = json_encode(['bureau_token' => $bearer], JSON_UNESCAPED_UNICODE);
    $headers = [
        'Accept: application/json',
        'Content-Type: application/json',
        'Authorization: Bearer ' . $bearer,
    ];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 45,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        $raw = curl_exec($ch);
        $fail['http'] = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $cerr = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            $fail['error'] = $cerr ? "Render injoignable : {$cerr}" : 'Render injoignable';
            return $fail;
        }
        $data = json_decode((string) $raw, true);
        if ($fail['http'] === 200 && !empty($data['password']) && is_string($data['password'])) {
            return ['password' => $data['password'], 'http' => 200, 'error' => ''];
        }
        $fail['error'] = is_array($data) ? (string) ($data['error'] ?? $data['hint'] ?? substr((string) $raw, 0, 120)) : substr((string) $raw, 0, 120);
        return $fail;
    }

    $fail['error'] = 'Extension curl absente sur l’hébergement';
    return $fail;
}

function mailbox_resolve_password(array $account, string $bearer, ?string $plainOverride = null): string {
    if ($plainOverride !== null && $plainOverride !== '') {
        return $plainOverride;
    }

    $render = mailbox_fetch_password_from_render((int) ($account['id'] ?? 0), $bearer);
    if ($render['password'] !== null && $render['password'] !== '') {
        return $render['password'];
    }

    try {
        return mailbox_decrypt((string) ($account['password_enc'] ?? ''));
    } catch (Throwable $e) {
        $parts = array_filter([
            $render['error'] ? 'Render : ' . $render['error'] : '',
            $render['http'] ? 'HTTP ' . $render['http'] : '',
            $e->getMessage(),
        ]);
        throw new RuntimeException(
            implode(' — ', $parts)
            . '. Solution : réessayez en saisissant le mot de passe SMTP (invite) ou modifiez le compte mail dans le bureau.'
        );
    }
}

function mailbox_supabase_request(string $method, string $path, ?array $body = null): array {
    $base = rtrim((string) mailbox_cfg('SUPABASE_URL', ''), '/');
    $key = (string) mailbox_cfg('SUPABASE_SERVICE_ROLE_KEY', '');
    if ($base === '' || $key === '') {
        throw new RuntimeException('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans mailbox-relay.config.php');
    }
    $url = $base . '/rest/v1/' . ltrim($path, '/');
    $headers = [
        'apikey: ' . $key,
        'Authorization: Bearer ' . $key,
        'Content-Type: application/json',
        'Accept: application/json',
    ];
    $payload = $body !== null ? json_encode($body, JSON_UNESCAPED_UNICODE) : null;

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 25,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        }
        $raw = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        return ['code' => $code, 'data' => $data, 'raw' => $raw];
    }

    $opts = [
        'http' => [
            'method' => $method,
            'header' => implode("\r\n", $headers),
            'timeout' => 25,
            'ignore_errors' => true,
        ],
    ];
    if ($payload !== null) {
        $opts['http']['content'] = $payload;
    }
    $ctx = stream_context_create($opts);
    $raw = @file_get_contents($url, false, $ctx);
    $code = 0;
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
        $code = (int) $m[1];
    }
    $data = $raw ? json_decode($raw, true) : null;
    return ['code' => $code, 'data' => $data, 'raw' => $raw];
}

function mailbox_auth_user(string $token): ?array {
    $token = trim($token);
    $token = preg_replace('/[^a-f0-9]/i', '', $token);
    if (strlen($token) < 32) {
        return null;
    }
    $enc = rawurlencode($token);

    // 1) Session seule (fiable si embed PostgREST échoue)
    $sr = mailbox_supabase_request('GET', "sessions?token=eq.{$enc}&select=expires_at,user_id&limit=1");
    if ($sr['code'] !== 200 || !is_array($sr['data']) || !isset($sr['data'][0])) {
        return null;
    }
    $sess = $sr['data'][0];
    $exp = $sess['expires_at'] ?? '';
    if ($exp === '' || strtotime($exp) < time()) {
        return null;
    }
    $userId = (int) ($sess['user_id'] ?? 0);
    if ($userId < 1) {
        return null;
    }

    // 2) Utilisateur
    $ur = mailbox_supabase_request('GET', "users?id=eq.{$userId}&select=id,username,role,active,permissions&limit=1");
    if ($ur['code'] !== 200 || !is_array($ur['data']) || !isset($ur['data'][0])) {
        $ur = mailbox_supabase_request('GET', "users?id=eq.{$userId}&select=id,username,role,active&limit=1");
    }
    if ($ur['code'] !== 200 || !is_array($ur['data']) || !isset($ur['data'][0])) {
        return null;
    }
    $user = $ur['data'][0];
    if (empty($user['active'])) {
        return null;
    }

    // Prolonge la session (comme l’API Node)
    $newExp = gmdate('Y-m-d\TH:i:s\Z', time() + 8 * 3600);
    mailbox_supabase_request('PATCH', "sessions?token=eq.{$enc}", ['expires_at' => $newExp]);

    return $user;
}

function mailbox_role_ok(array $user, string $minRole): bool {
    $roles = ['agent' => 1, 'admin' => 2, 'super_admin' => 3];
    return ($roles[$user['role'] ?? ''] ?? 0) >= ($roles[$minRole] ?? 0);
}

function mailbox_load_account(int $id): ?array {
    $q = 'mailbox_accounts?id=eq.' . $id
        . '&select=id,label,email,password_enc,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,active'
        . '&limit=1';
    $r = mailbox_supabase_request('GET', $q);
    if ($r['code'] !== 200 || !is_array($r['data']) || !isset($r['data'][0])) {
        return null;
    }
    $acc = $r['data'][0];
    if (empty($acc['active'])) {
        return null;
    }
    return $acc;
}

function mailbox_sanitize_recipients($input): array {
    if ($input === null) {
        return [];
    }
    $raw = is_array($input) ? implode(',', $input) : (string) $input;
    $out = [];
    $seen = [];
    foreach (preg_split('/[\s,;]+/', $raw) as $part) {
        $t = trim($part, " \t<>");
        if ($t === '' || !filter_var($t, FILTER_VALIDATE_EMAIL)) {
            continue;
        }
        $k = strtolower($t);
        if (isset($seen[$k])) {
            continue;
        }
        $seen[$k] = true;
        $out[] = $t;
        if (count($out) >= 50) {
            break;
        }
    }
    return $out;
}

function mailbox_build_matrix(array $account): array {
    $matrix = [];
    $add = function (string $host, int $port, bool $secure) use (&$matrix): void {
        if ($host === '') {
            return;
        }
        $key = "{$host}:{$port}:" . ($secure ? '1' : '0');
        foreach ($matrix as $m) {
            if ("{$m['host']}:{$m['port']}:" . ($m['secure'] ? '1' : '0') === $key) {
                return;
            }
        }
        $matrix[] = ['host' => $host, 'port' => $port, 'secure' => $secure];
    };

    $email = strtolower((string) ($account['email'] ?? ''));
    $domain = strpos($email, '@') !== false ? substr($email, strpos($email, '@') + 1) : '';

    $prefHost = (string) ($account['smtp_host'] ?? $account['imap_host'] ?? '');
    $prefPort = (int) ($account['smtp_port'] ?? 465);
    $prefSecure = !empty($account['smtp_secure']);
    if ($prefHost !== '') {
        $add($prefHost, $prefPort > 0 ? $prefPort : 465, $prefSecure);
    }
    if ($domain !== '') {
        $add('mail.' . $domain, 587, false);
        $add('mail.' . $domain, 465, true);
    }
    return array_slice($matrix, 0, 6);
}

function afrilex_smtp_attempt(array $cfg): array {
    $host = (string) ($cfg['host'] ?? '');
    $port = (int) ($cfg['port'] ?? 465);
    $secure = !empty($cfg['secure']);
    $user = (string) ($cfg['user'] ?? '');
    $pass = (string) ($cfg['pass'] ?? '');
    $verifyOnly = !empty($cfg['verify_only']);

    if ($host === '' || $user === '' || $pass === '') {
        return ['ok' => false, 'error' => 'host/user/pass requis'];
    }

    $errno = 0;
    $errstr = '';
    $remote = ($secure && $port === 465) ? "ssl://{$host}:{$port}" : "tcp://{$host}:{$port}";
    $ctx = stream_context_create([
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false,
            'allow_self_signed' => true,
        ],
    ]);

    $fp = @stream_socket_client($remote, $errno, $errstr, 12, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) {
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => "Connexion : {$errstr} ({$errno})"];
    }
    stream_set_timeout($fp, 45);

    $read = function () use ($fp): string {
        $out = '';
        while (!feof($fp)) {
            $line = fgets($fp, 8192);
            if ($line === false) {
                break;
            }
            $out .= $line;
            if (isset($line[3]) && $line[3] === ' ') {
                break;
            }
        }
        return $out;
    };
    $cmd = function (string $c) use ($fp, $read): string {
        fwrite($fp, $c . "\r\n");
        return $read();
    };

    $greet = $read();
    if (!preg_match('/^220/', $greet)) {
        fclose($fp);
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'Pas de bannière SMTP'];
    }

    $ehlo = $cmd('EHLO afrilex.local');
    if (!preg_match('/^250/', $ehlo)) {
        fclose($fp);
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'EHLO refusé'];
    }

    if (!$secure && $port !== 465 && stripos($ehlo, 'STARTTLS') !== false) {
        $tls = $cmd('STARTTLS');
        if (!preg_match('/^220/', $tls)) {
            fclose($fp);
            return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'STARTTLS refusé'];
        }
        if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            fclose($fp);
            return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'TLS échouée'];
        }
        $ehlo = $cmd('EHLO afrilex.local');
    }

    $authed = false;
    $a2 = $cmd('AUTH LOGIN');
    if (preg_match('/^334/', $a2)) {
        $cmd(base64_encode($user));
        $p = $cmd(base64_encode($pass));
        if (preg_match('/^235/', $p)) {
            $authed = true;
        }
    }
    if (!$authed) {
        $a1 = $cmd('AUTH PLAIN ' . base64_encode("\0{$user}\0{$pass}"));
        if (preg_match('/^235/', $a1)) {
            $authed = true;
        }
    }
    if (!$authed) {
        fclose($fp);
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'Identifiants SMTP invalides'];
    }

    if ($verifyOnly) {
        $cmd('QUIT');
        fclose($fp);
        return ['ok' => true, 'host' => $host, 'port' => $port, 'secure' => $secure, 'verified' => true];
    }

    $from = (string) ($cfg['from'] ?? $user);
    $toList = $cfg['to'] ?? [];
    if (!is_array($toList)) {
        $toList = [$toList];
    }
    $toList = array_values(array_filter(array_map('strval', $toList)));
    if (count($toList) === 0) {
        fclose($fp);
        return ['ok' => false, 'error' => 'Aucun destinataire'];
    }

    $subject = (string) ($cfg['subject'] ?? '(sans objet)');
    $text = (string) ($cfg['text'] ?? '');
    $html = (string) ($cfg['html'] ?? '');
    $messageId = (string) ($cfg['message_id'] ?? ('<' . bin2hex(random_bytes(12)) . '@' . preg_replace('/^.*@/', '', $from) . '>'));

    if (!preg_match('/^250/', $cmd('MAIL FROM:<' . $from . '>'))) {
        fclose($fp);
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'MAIL FROM refusé'];
    }

    $accepted = [];
    foreach ($toList as $rcpt) {
        $r = $cmd('RCPT TO:<' . $rcpt . '>');
        if (preg_match('/^250|^251/', $r)) {
            $accepted[] = $rcpt;
        }
    }
    if (count($accepted) === 0) {
        fclose($fp);
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'RCPT refusé'];
    }

    if (!preg_match('/^354/', $cmd('DATA'))) {
        fclose($fp);
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'DATA refusé'];
    }

    $headers = [
        'From: ' . $from,
        'To: ' . implode(', ', $toList),
        'Subject: =?UTF-8?B?' . base64_encode($subject) . '?=',
        'Message-ID: ' . $messageId,
        'MIME-Version: 1.0',
        'Date: ' . date('r'),
        'Content-Type: text/plain; charset=UTF-8',
    ];
    $payload = implode("\r\n", $headers) . "\r\n\r\n" . $text;
    if ($html !== '') {
        $boundary = 'afrilex_' . bin2hex(random_bytes(8));
        $headers[6] = 'Content-Type: multipart/alternative; boundary="' . $boundary . '"';
        $payload = implode("\r\n", $headers) . "\r\n\r\n";
        $payload .= "--{$boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{$text}\r\n";
        $payload .= "--{$boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{$html}\r\n--{$boundary}--";
    }
    $payload = preg_replace('/^\./m', '..', $payload);
    fwrite($fp, $payload . "\r\n.\r\n");
    $dataResp = $read();
    $cmd('QUIT');
    fclose($fp);

    if (!preg_match('/^250/', $dataResp)) {
        return ['ok' => false, 'host' => $host, 'port' => $port, 'secure' => $secure, 'error' => 'Envoi refusé : ' . trim($dataResp)];
    }

    return [
        'ok' => true,
        'host' => $host,
        'port' => $port,
        'secure' => $secure,
        'messageId' => $messageId,
        'accepted' => $accepted,
        'rejected' => array_values(array_diff($toList, $accepted)),
    ];
}

function mailbox_send_account(array $account, array $mail, bool $verifyOnly = false, string $bearer = '', ?string $smtpPasswordOverride = null): array {
    try {
        $pass = mailbox_resolve_password($account, $bearer, $smtpPasswordOverride);
    } catch (Throwable $e) {
        return [
            'ok' => false,
            'error' => $e->getMessage(),
            'needs_smtp_password' => true,
        ];
    }

    $matrix = mailbox_build_matrix($account);
    $log = [];
    $lastErr = 'SMTP indisponible';
    foreach ($matrix as $t) {
        $r = afrilex_smtp_attempt([
            'host' => $t['host'],
            'port' => $t['port'],
            'secure' => $t['secure'],
            'user' => $account['email'],
            'pass' => $pass,
            'verify_only' => $verifyOnly,
            'from' => $account['email'],
            'to' => $mail['to'] ?? [],
            'subject' => $mail['subject'] ?? '',
            'text' => $mail['text'] ?? '',
            'html' => $mail['html'] ?? '',
        ]);
        $log[] = $r;
        if (!empty($r['ok'])) {
            return [
                'ok' => true,
                'via' => 'lws',
                'working' => ['host' => $r['host'], 'port' => $r['port'], 'secure' => $r['secure']],
                'messageId' => $r['messageId'] ?? null,
                'accepted' => $r['accepted'] ?? [],
                'rejected' => $r['rejected'] ?? [],
                'attempted' => $log,
            ];
        }
        $lastErr = $r['error'] ?? $lastErr;
        if (stripos($lastErr, 'Identifiants') !== false) {
            break;
        }
    }
    return ['ok' => false, 'via' => 'lws', 'error' => $lastErr, 'attempted' => $log];
}
