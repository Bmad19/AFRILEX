<?php
// ── NUMAFRIQ — Configuration Base de Données MySQL (LWS) ─────────────────────
// Remplissez ces valeurs avec celles fournies par LWS dans votre cPanel

define('DB_HOST',     'localhost');         // Hôte MySQL LWS (généralement localhost)
define('DB_NAME',     'numafriq_bureau');   // Nom de votre base de données
define('DB_USER',     'numafriq_user');     // Nom d'utilisateur MySQL
define('DB_PASS',     'VotreMotDePasse');   // Mot de passe MySQL
define('DB_CHARSET',  'utf8mb4');

// Relais envoi boîte mail (généré par node scripts/setup-mailbox-relay.mjs)
$_relay = __DIR__ . '/mailbox-relay.config.php';
if (is_file($_relay)) {
    require_once $_relay;
}
unset($_relay);

// ── Connexion PDO MySQL (singleton) ──────────────────────────────────────────
function get_db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        try {
            $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
            $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        } catch (PDOException $e) {
            http_response_code(503);
            echo json_encode(['error' => 'Erreur de connexion à la base de données : ' . $e->getMessage()]);
            exit;
        }
    }
    return $pdo;
}
