// Generates the AUTH_PASSWORD_HASH value for local auth mode.
// Usage: bun run scripts/hash-password.ts <password>
const password = process.argv[2]
if (!password) {
	console.error('Usage: bun run scripts/hash-password.ts <password>')
	process.exit(1)
}

const hash = await Bun.password.hash(password)

// The hash is $-delimited (argon2id); Bun's .env loader expands unescaped $
// sequences as variable references, which silently truncates the hash. Quote
// and escape it so the printed line is safe to paste into .env as-is.
console.log(`AUTH_PASSWORD_HASH="${hash.replace(/\$/g, '\\$')}"`)

export {}
