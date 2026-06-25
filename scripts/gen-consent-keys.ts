/**
 * Generate an Ed25519 key pair for OAuth2 consent signing.
 *
 * Usage:  bun scripts/gen-consent-keys.ts
 *
 * Output:
 *   1. Private JWK — set as OAUTH_CONSENT_KEY in Warden's .env
 *   2. Public JWK  — register with the OAuth2 client via orbit-dash
 *      or PATCH /internal/oauth2/clients/:id { consent_jwk: <public> }
 */
const keyPair = await crypto.subtle.generateKey('Ed25519' as any, true, ['sign', 'verify'])

const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

// Strip the private key material from the public JWK
const { d: _, ...publicOnly } = publicJwk

console.log('=== PRIVATE KEY (OAUTH_CONSENT_KEY in .env) ===')
console.log(JSON.stringify(privateJwk))
console.log()
console.log('=== PUBLIC KEY (consent_jwk for OAuth2 client) ===')
console.log(JSON.stringify(publicOnly))
console.log()
console.log('Set OAUTH_CONSENT_KEY in .env to the private key JSON string (single line).')
console.log('Update the OAuth2 client consent_jwk with the public key via:')
console.log('  PATCH /internal/oauth2/clients/<client_id> { "consent_jwk": <public key JSON> }')
