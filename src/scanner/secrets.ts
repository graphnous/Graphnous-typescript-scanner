/**
 * What a scan result must not hold: secrets, by the name they are kept
 * under or by the value itself, as the scan result schema describes them
 * for constants.
 */

/**
 * Words in a name that name a secret, in lower case, without "-", "_"
 * and ".". Not "key" alone, so names such as routingKey are kept.
 */
const SECRET_NAMES = [
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "apikey",
    "accesskey",
    "privatekey",
    "authorization"
];

/**
 * A url with a user and a password, as in postgresql://app:secret@db/orders.
 */
const URL_WITH_PASSWORD = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s@:]*:[^/\s@]+@/;

/**
 * Whether the name of a constant names a secret, such as API_KEY or
 * dbPassword.
 */
export function namesSecret(name: string): boolean {
    const normalized = name.toLowerCase().replace(/[-_.]/g, "");

    return SECRET_NAMES.some(word => normalized.includes(word));
}

/**
 * Whether the value holds a secret: a url with a password, a password=
 * setting, or a private key.
 */
export function holdsSecret(value: string): boolean {
    return URL_WITH_PASSWORD.test(value)
        || value.toLowerCase().includes("password=")
        || value.includes("-----BEGIN");
}
