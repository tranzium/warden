# Service Log On Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and change an NSSM service's Log On account (`ObjectName`) from a new "Log on" card on Warden's existing settings page.

**Architecture:** A new `src/nssm/logon.ts` holds the pure decision logic (form parse, save table, messages, secret scrubbing) plus two thin side-effecting functions: account lookup (spawned PowerShell, account passed via env var) and apply (`nssm set <svc> ObjectName ...`). The settings route reads `ObjectName`, renders a new card, applies Log On as one more "only if changed" step in the existing save, and adds a JSON lookup endpoint for the card's "Check" button. A repo script proves the real NSSM path from an elevated prompt.

**Tech Stack:** Bun + TypeScript, server-rendered HTML, Bootstrap 5.3, NSSM, PowerShell 5.1 (lookup only).

**Spec:** `docs/superpowers/specs/2026-11-11-service-logon-design.md`

## Global Constraints

- NSSM is the only mechanism for changing Log On; no Bun FFI / Win32 calls.
- The password appears nowhere except the single `nssm set ... ObjectName <account> <password>` invocation: not in DB, logs, stdout/stderr, error flash, redirect URL, rendered HTML.
- Password inputs: `type="password"`, `autocomplete="new-password"`, never prefilled.
- Account input is never rewritten (no `./` -> `.\` normalization); `./` only produces a backslash suggestion.
- Permission: `services.install` (no new permission).
- Warden itself (`isSelf`): card read-only; server rejects any posted Log On change.
- Header unchanged; no tabs; no dashboard / install-form changes.
- No audit record, no dry-run mode in the feature.
- NSSM / Windows error text shown verbatim (password scrubbed).
- Repo: tabs, CRLF best effort, ASCII, no version bump, bun only (never node/npm), no python.
- Commits: first line summary, one line per change, no empty lines, no Co-Authored-By.

## Review Focus

- Account differs from current only by case or surrounding whitespace (`.\Taskflow ` vs `.\taskflow`), password blank -> no change (not "password required"). Test: Task 1.
- Account containing PowerShell metacharacters (`'; exit 0; '`, `$(...)`) -> treated as data, lookup returns null, nothing executed. Test: Task 1.
- Short password that also appears in NSSM output -> scrubbed; empty/null secret leaves text unchanged. Test: Task 1.
- `ObjectName` unreadable (`nssmGet` returns null) -> treated as LocalSystem; card shows `LocalSystem` with Local System selected. Test: Tasks 1 and 2.
- Form posted without Log On fields (Warden's own read-only page, stale cached page) -> no Log On change and no error; Log On fields posted for Warden itself -> error. Test: Task 1 (`parseLogonForm`), Task 3 (route rule).

---

### Task 1: Log On core module

**Files:**
- Create: `src/nssm/logon.ts`
- Create: `scripts/smoke-logon.ts`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: `nssmSet(name, parameter, ...values)` from `src/nssm/client.ts`.
- Produces:
	```ts
	export const LOCAL_SYSTEM = 'LocalSystem'
	export const SCRUBBED = '********'
	export type LogonKind = 'system' | 'user'
	export interface LogonForm { kind: LogonKind; account: string; password: string; confirm: string }
	export type LogonSet = { action: 'set'; account: string; password: string | null }
	export type LogonPlan = { action: 'none' } | LogonSet | { action: 'error'; message: string }
	export function isLocalSystem(objectName: string | null): boolean
	export function parseLogonForm(form: FormData): LogonForm | null
	export function planLogon(current: string | null, form: LogonForm): LogonPlan
	export function backslashSuggestion(account: string): string | null
	export function accountNotFound(account: string): string
	export function scrubSecret(text: string, secret: string | null): string
	export async function lookupAccount(account: string): Promise<string | null>
	export async function applyLogon(service: string, plan: LogonSet): Promise<{ ok: boolean; output: string }>
	```

Exact messages (copy verbatim):
- `Passwords do not match`
- `Account is required`
- `A password is required when changing the account`
- `accountNotFound('nobody')` -> `Account not found: nobody`
- `accountNotFound('./Devan')` -> `Account not found: ./Devan - did you mean .\Devan?`

- [ ] **Step 1: Write the failing tests in `scripts/smoke-logon.ts`**

Follow `scripts/smoke.ts` style (plain throws, `console.log('smoke-logon ok')`, `process.exit(0)`). Set the same dummy env as `scripts/smoke.ts` before `await import('../src/nssm/logon')` (`client.ts` imports `config.ts`, which exits without `COOKIE_SECRET` / `AUTH_PASSWORD_HASH`). Assertions:

```ts
const L = await import('../src/nssm/logon')
const user = (account: string, password = '', confirm = password) => ({ kind: 'user' as const, account, password, confirm })
const sys = { kind: 'system' as const, account: '', password: '', confirm: '' }
const eq = (a: unknown, b: unknown, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)}`) }

// isLocalSystem
eq([L.isLocalSystem('LocalSystem'), L.isLocalSystem('localsystem'), L.isLocalSystem(null), L.isLocalSystem(''), L.isLocalSystem('.\\taskflow')], [true, true, true, true, false], 'isLocalSystem')

// save table (spec "Save")
eq(L.planLogon('LocalSystem', sys), { action: 'none' }, 'system->system')
eq(L.planLogon(null, sys), { action: 'none' }, 'unreadable->system')
eq(L.planLogon('.\\taskflow', sys), { action: 'set', account: 'LocalSystem', password: null }, 'user->system')
eq(L.planLogon('.\\taskflow', user('.\\taskflow')), { action: 'none' }, 'same, blank')
eq(L.planLogon('.\\taskflow', user(' .\\Taskflow ')), { action: 'none' }, 'same ignoring case/space, blank')
eq(L.planLogon('.\\taskflow', user('.\\taskflow', 'n3w')), { action: 'set', account: '.\\taskflow', password: 'n3w' }, 'rotation')
eq(L.planLogon('LocalSystem', user('.\\Devan')), { action: 'error', message: 'A password is required when changing the account' }, 'change, blank')
eq(L.planLogon('LocalSystem', user('.\\Devan', 'a', 'b')), { action: 'error', message: 'Passwords do not match' }, 'mismatch')
eq(L.planLogon('.\\Devan', user('.\\Devan', 'a', 'b')), { action: 'error', message: 'Passwords do not match' }, 'mismatch same account')
eq(L.planLogon('LocalSystem', user('  ', 'a')), { action: 'error', message: 'Account is required' }, 'empty account')
eq(L.planLogon('LocalSystem', user(' .\\Devan ', 'p w"\\')), { action: 'set', account: '.\\Devan', password: 'p w"\\' }, 'account trimmed, password untouched')

// parseLogonForm: fields logonKind, logonAccount, logonPassword, logonConfirm
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f }
eq(L.parseLogonForm(fd({ program: 'x' })), null, 'no logon fields -> null')
eq(L.parseLogonForm(fd({ logonKind: 'system' })), sys, 'system parse')
eq(L.parseLogonForm(fd({ logonKind: 'user', logonAccount: '.\\a', logonPassword: ' p ', logonConfirm: ' p ' })), user('.\\a', ' p ', ' p '), 'user parse keeps password whitespace')
eq(L.parseLogonForm(fd({ logonKind: 'bogus' })), null, 'unknown kind -> null')

// messages
eq(L.backslashSuggestion('./Devan'), '.\\Devan', 'suggest')
eq(L.backslashSuggestion('.\\Devan'), null, 'no suggest')
eq(L.accountNotFound('nobody'), 'Account not found: nobody', 'not found')
eq(L.accountNotFound('./Devan'), 'Account not found: ./Devan - did you mean .\\Devan?', 'not found + hint')

// scrubSecret
eq(L.scrubSecret('bad pw Error here Error', 'Error'), 'bad pw ******** here ********', 'scrub all')
eq(L.scrubSecret('text', ''), 'text', 'empty secret')
eq(L.scrubSecret('text', null), 'text', 'null secret')

// lookupAccount: real PowerShell, Windows only
if (process.platform === 'win32') {
	const me = process.env.USERNAME!, host = process.env.COMPUTERNAME!
	const r = await L.lookupAccount(`.\\${me}`)
	if (r?.toLowerCase() !== `${host}\\${me}`.toLowerCase()) throw new Error('local account should resolve: ' + r)
	eq(await L.lookupAccount(`./${me}`), null, 'forward slash rejected')
	eq(await L.lookupAccount('warden-no-such-user-zz'), null, 'unknown')
	eq(await L.lookupAccount("x'; exit 0; '"), null, 'quote injection is data')
	eq(await L.lookupAccount('$(exit 0)'), null, 'subexpression is data')
	eq(await L.lookupAccount(''), null, 'empty')
}
```

- [ ] **Step 2: Add to `package.json` `test`:** `bun run scripts/smoke.ts && bun run scripts/smoke-migrate.ts && bun run scripts/smoke-logon.ts`

- [ ] **Step 3: Run to verify it fails**

Run: `bun run scripts/smoke-logon.ts`
Expected: FAIL (cannot resolve `../src/nssm/logon`)

- [ ] **Step 4: Implement `src/nssm/logon.ts`**

- Account comparison (internal): trim + case-insensitive. `planLogon` order: kind `system` first; then mismatch check; then empty account; then same/different table. Returned `account` is trimmed; password returned exactly as typed.
- `parseLogonForm`: returns null when `logonKind` is absent or not `system`/`user`; account trimmed; passwords not trimmed.
- `lookupAccount`: return null for blank input without spawning. Otherwise spawn `['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', LOOKUP_PS]` with `env: { ...process.env, WARDEN_ACCOUNT: account }`; resolved = trimmed stdout when exit code 0 and non-empty, else null; any throw -> null. The account must never be interpolated into the script. Script (exact):
	```
	$n = $env:WARDEN_ACCOUNT; if ($n.StartsWith('.\')) { $n = $env:COMPUTERNAME + $n.Substring(1) }; try { $s = ([System.Security.Principal.NTAccount]$n).Translate([System.Security.Principal.SecurityIdentifier]); $s.Translate([System.Security.Principal.NTAccount]).Value } catch { exit 1 }
	```
	(Mapping `.\` to the machine name happens only inside the lookup; the user's input is not changed.)
- `applyLogon`: for `LocalSystem` -> `nssmSet(service, 'ObjectName', 'LocalSystem')`. Otherwise `lookupAccount(plan.account)`; null -> `{ ok: false, output: accountNotFound(plan.account) }` without calling NSSM; else `nssmSet(service, 'ObjectName', plan.account, plan.password ?? '')` (account as entered). Return `output` passed through `scrubSecret(output, plan.password)`.

- [ ] **Step 5: Run tests**

Run: `bun run test` and `bunx tsc --noEmit`
Expected: `smoke ok`, migrate output, `smoke-logon ok`; tsc clean.

- [ ] **Step 6: Commit**

```
git add src/nssm/logon.ts scripts/smoke-logon.ts package.json
git commit -m "feat(logon): add Log On decision logic, account lookup, nssm apply
Pure save table, form parse, messages, secret scrubbing
Account lookup via PowerShell with account passed as env var
smoke-logon covers table, parsing, scrubbing, lookup on Windows"
```

---

### Task 2: Log On card (read + render + client behavior)

**Files:**
- Modify: `src/views/settings.ts` (new `logonCard`, `settingsPage` signature, Save button id)
- Modify: `src/routes/settings.ts` (`settingsPageHandler` reads `ObjectName`)
- Create: `static/js/settings.js`
- Test: `scripts/smoke-logon.ts`

**Interfaces:**
- Consumes: `isLocalSystem`, `LOCAL_SYSTEM` from Task 1.
- Produces:
	```ts
	export function logonCard(current: string | null, isSelf: boolean, service: string): string
	export function settingsPage(name: string, cfg: ServiceConfig, logon: string | null, isSelf: boolean, flash: {...}, opts: PageOpts): Response
	```
	Form field names `logonKind` (`system`|`user`), `logonAccount`, `logonPassword`, `logonConfirm`; element ids `logon-user-fields`, `logon-account`, `logon-check`, `logon-hint`, `logon-password`, `logon-confirm`, `logon-match`, Save button `id="save"`; card root has `data-lookup="/services/<encoded name>/logon/lookup"`.

- [ ] **Step 1: Add failing tests to `scripts/smoke-logon.ts`** (`await import('../src/views/settings')`)

```ts
const V = await import('../src/views/settings')
const c1 = V.logonCard('.\\taskflow', false, 'tf remote')
for (const s of ['name="logonKind"', 'value="system"', 'value="user"', 'name="logonAccount"', 'value=".\\taskflow"', 'name="logonPassword"', 'name="logonConfirm"', 'autocomplete="new-password"', 'id="logon-check"', 'data-lookup="/services/tf%20remote/logon/lookup"'])
	if (!c1.includes(s)) throw new Error('card missing ' + s)
if (/name="logon(Password|Confirm)"[^>]*value=/.test(c1)) throw new Error('password inputs must never carry a value')
if (!/value="user"[^>]*checked/.test(c1)) throw new Error('named account -> This account selected')
const c2 = V.logonCard(null, false, 'x')
if (!c2.includes('LocalSystem') || !/value="system"[^>]*checked/.test(c2)) throw new Error('unreadable -> LocalSystem selected')
const c3 = V.logonCard('LocalSystem', true, 'warden')
if (c3.includes('<input') || !c3.includes('LocalSystem')) throw new Error('self card must be read-only with no inputs')
const c4 = V.logonCard('.\\a"b<', false, 'x')
if (c4.includes('a"b<')) throw new Error('account must be escaped')
```

- [ ] **Step 2: Run** `bun run scripts/smoke-logon.ts` -> FAIL (`logonCard` not a function).

- [ ] **Step 3: Implement `logonCard` in `src/views/settings.ts`**

Markup follows the existing cards (`card mb-3`, `card-header`, `card-body`), matching the approved mockup option A:
- Header: `Log on` + right-aligned small muted `Currently: <code>{current or LocalSystem}</code>`.
- Radios `logonKind`: "Local System account" (`system`), "This account" (`user`); checked per `isLocalSystem(current)`.
- `#logon-user-fields` (hidden by JS when `system`): Account as Bootstrap `input-group` (`#logon-account` text, prefilled with current when not LocalSystem, `autocomplete="off"`) + `button type="button" class="btn btn-outline-secondary" id="logon-check"` "Check"; `#logon-hint` `form-text` below the group; Password (`#logon-password`, placeholder `Leave blank to keep current`); Confirm (`#logon-confirm`); `#logon-match` `form-text` under Confirm.
- Note `form-text`: `Sent once to Windows; Warden never stores or logs it. Required when changing the account.`
- Self: header the same; body is one line with the account and `Warden runs as LocalSystem so it can install and remove services; its Log On cannot be changed here.` No inputs.
- All dynamic values through `esc()`.

`settingsPage`: add `logon` param (position per Interfaces), insert `${logonCard(logon, isSelf, name)}` after `${configFieldSections(cfg)}` and before `${noticeBox}`; Save button gets `id="save"`; pass `{ ...opts, scripts: true, script: '/static/js/settings.js' }` to `page()` unless `isSelf`.

- [ ] **Step 4: `settingsPageHandler`** reads `nssmGet(actual, 'ObjectName')` (in parallel with `readRaw`; not added to `PARAMS`, so the existing save diff is untouched) and passes it to `settingsPage`.

- [ ] **Step 5: `static/js/settings.js`** (plain script, same style as `static/js/logs.js`; no-op if `#logon-account` missing):
- Toggle `#logon-user-fields` on `logonKind` change.
- Match indicator on `input` of either password field: both empty -> blank; equal -> `Passwords match` (`text-success`); else `Passwords do not match` (`text-danger`) and `#save` disabled; re-enabled when they match or both empty, or when `system` selected.
- Lookup on `#logon-check` click and on `#logon-account` `blur` (skip blur if value unchanged since last lookup): `fetch(dataLookup + '?account=' + encodeURIComponent(v))`; show `Resolves to <resolved>` (`text-success`) or the response `message` (`text-danger`); network failure -> `Could not check account` (`text-warning`). Use `textContent`, never `innerHTML`, for server values.

- [ ] **Step 6: Run** `bun run test` + `bunx tsc --noEmit` -> all ok.

- [ ] **Step 7: Commit**

```
git add src/views/settings.ts src/routes/settings.ts static/js/settings.js scripts/smoke-logon.ts
git commit -m "feat(settings): add Log on card showing current account
Card with Local System / This account, Check input group, password confirm
Client script for match indicator, Save gating, account lookup hint
Settings page reads nssm ObjectName; read-only card for Warden itself"
```

---

### Task 3: Save Log On, lookup endpoint, SECURITY.md

**Files:**
- Modify: `src/routes/settings.ts` (`settingsSaveHandler`, new `logonLookupHandler`)
- Modify: `src/router.ts` (route)
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: Task 1 `parseLogonForm`, `planLogon`, `applyLogon`, `lookupAccount`, `accountNotFound`; Task 2 field names and `data-lookup` URL.
- Produces: `export async function logonLookupHandler(ctx: AuthContext, req: Request): Promise<Response>`; route `GET /services/:name/logon/lookup?account=...` -> `200 {"resolved":"PICKWICKDRIVE\\taskflow"}` or `200 {"resolved":null,"message":"Account not found: ..."}`; `403` (`forbidden()`) without `services.install`.

- [ ] **Step 1: `logonLookupHandler`** in `src/routes/settings.ts`: permission check first; `account` from query (trimmed); `lookupAccount`; respond via `ok(...)` from `src/shared/http.ts` with `message: accountNotFound(account)` when null.

- [ ] **Step 2: Router:** in the `serviceMatch` block add `if (sub === '/logon/lookup' && method === 'GET') return logonLookupHandler(ctx, req)`.

- [ ] **Step 3: `settingsSaveHandler`:** after the existing parameter loop and before the restart block:
- `const logonForm = parseLogonForm(form)`.
- If `isSelf(actual)` and `logonForm` is not null -> `fail('Log On cannot be changed for Warden itself')`.
- If not self and `logonForm`: `const plan = planLogon(await nssmGet(actual, 'ObjectName'), logonForm)`; `error` -> `fail(plan.message)`; `set` -> `applyLogon(actual, plan)`; not ok -> `fail(\`Failed to set Log On: ${result.output || 'unknown error'}\`)`.
- The password must not reach `fail()` / the redirect except through `applyLogon`'s scrubbed output.

- [ ] **Step 4: `SECURITY.md`:** add `## Service Log On changes` (after the threat model section) covering, from the spec "Security notes to document": gated by `services.install`, refused for Warden itself; password passed to `nssm set ... ObjectName <account> <password>` so it is on that short-lived process's command line, readable live only by admins/SYSTEM, persisted if process command-line auditing (event 4688, `ProcessCreationIncludeCmdLine_Enabled`) or Sysmon/EDR command-line logging is enabled (neither on the reference host, checked 2026-11-11); Windows stores it as an LSA secret, Warden stores nothing; Log On changes are not recorded in any audit log; password crosses the wire once in the form post, so keep Warden on localhost or behind TLS.

- [ ] **Step 5: Run** `bun run test` + `bunx tsc --noEmit` -> all ok.

- [ ] **Step 6: Manual UI check (dry, no save)** on a dev instance or after deploy: open a `.\taskflow` service's settings -> card shows `Currently: .\taskflow`; Check `./taskflow` -> not found with backslash hint; Check `.\taskflow` -> `Resolves to PICKWICKDRIVE\taskflow`; mismatched passwords disable Save; Warden's own page shows read-only card. Do not save a Log On change here; the live path is proven by Task 4.

- [ ] **Step 7: Commit**

```
git add src/routes/settings.ts src/router.ts SECURITY.md
git commit -m "feat(settings): apply Log On changes on save, add account lookup endpoint
Save plans Log On against live ObjectName and applies via nssm only if changed
Refuse Log On changes for Warden itself
GET /services/:name/logon/lookup for the Check button, gated by services.install
SECURITY.md: document password exposure, storage, and no-audit stance"
```

---

### Task 4: Elevated live check script

**Files:**
- Create: `scripts/logon-live-check.ts`
- Create: `docs/logon-live-check.md` (how to run it again)

**Interfaces:**
- Consumes: `lookupAccount`, `planLogon`, `applyLogon`, `isLocalSystem`, `nssmGet` (via the same dummy-env dynamic import as `scripts/smoke.ts`).
- Produces: nothing used by other tasks.

Fixed values: account `warden-logon-test`, service `warden-logon-test`, program `C:\Windows\System32\PING.EXE` with parameters `-n 3600 127.0.0.1`, flag `--live`. Passwords (each meets default complexity): `Pa ss w0rd!`, `Qu"ote1x`, `Back\slash1\`, `Pct%Path%9`, `Car^et&Amp1`.

- [ ] **Step 1: Write the script.** Behavior:
- Without `--live`: print the planned steps and exit 0; make no changes.
- With `--live`: refuse (exit 1) unless elevated; refuse if the account or service already exists.
- Account create / password change / delete via PowerShell `New-LocalUser` / `Set-LocalUser` / `Remove-LocalUser`, password passed via env var and `ConvertTo-SecureString -AsPlainText -Force`, never interpolated.
- Install the service with `nssm install`; never install as anything but this throwaway.
- For each password: set it on the account, `planLogon(current, user)` -> `applyLogon`, assert ok; `nssmGet(svc, 'ObjectName')` equals `.\warden-logon-test` (case-insensitive); `nssm start` succeeds and status reaches `SERVICE_RUNNING` (wrong password would fail with 1069); `nssm stop`; assert the password string is absent from all captured NSSM output.
- Negative cases: `applyLogon` with `./warden-logon-test` -> not ok, output equals `accountNotFound('./warden-logon-test')`, and `ObjectName` unchanged; wrong password -> apply may succeed but start must fail, and output contains no password.
- Confirm "Log on as a service": `secedit /export /areas USER_RIGHTS /cfg <tmp>.inf` contains the account SID under `SeServiceLogonRight`.
- Switch back: `applyLogon` with `LOCAL_SYSTEM` -> `ObjectName` is `LocalSystem`.
- `finally` cleanup, each step independent and reported: stop + `nssm remove <svc> confirm`; remove the user profile (`Get-CimInstance Win32_UserProfile | ? SID -eq <sid> | Remove-CimInstance`); remove the SID from `SeServiceLogonRight` via `secedit` export/edit/`secedit /configure /db <tmp>.sdb /cfg <tmp>.inf /areas USER_RIGHTS`, or report the SID as a harmless leftover if that fails; `Remove-LocalUser`; delete temp files.
- Print `PASS`/`FAIL` per check and a summary; ASCII only; exit 1 on any FAIL.

- [ ] **Step 2: Dry run (non-elevated session):** `bun run scripts/logon-live-check.ts` -> prints plan, exit 0, no account or service created (`Get-LocalUser warden-logon-test` fails, `nssm status warden-logon-test` fails).

- [ ] **Step 3: Write `docs/logon-live-check.md`:** purpose, prerequisites (elevated prompt, nssm on PATH or `NSSM_PATH`), command `bun run scripts/logon-live-check.ts --live`, what it creates and removes, expected summary.

- [ ] **Step 4: Commit**

```
git add scripts/logon-live-check.ts docs/logon-live-check.md
git commit -m "test(logon): add elevated live check for nssm Log On path
Throwaway account and service, tricky passwords proven by real service start
Verifies lookup rejection, no password in output, logon right, full cleanup
Dry-run by default; --live required"
```

- [ ] **Step 5: Hand off to the user** to run `bun run scripts/logon-live-check.ts --live` from an elevated prompt in the worktree; collect the summary. Any FAIL goes back through systematic debugging before merge.
