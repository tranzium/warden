# Service Log On account (nssm ObjectName) - parked notes

Status: **superseded** (2026-11-11) by `docs/superpowers/specs/2026-11-11-service-logon-design.md`.

## Why this came up

`bugle` failed to run an `.exe`: an environment variable pointed at a path under the `Devan` profile while the service runs as `.\taskflow`. Fixed by pointing it at the taskflow path. Diagnosis took a detour through another session because nothing showed which account the service runs as.

The real gap was **visibility**, not configurability.

## Findings (as of 2026-11-11)

### Live Log On (`StartName`) on this machine

| Account | Services |
|---|---|
| `.\taskflow` | `bugle`, `tf-agent`, `tf-dash`, `tf-remote` |
| `LocalSystem` | all others, including **`warden` itself** |

- Warden is LocalSystem by design: nssm install/remove needs admin (README.md "remote code execution as SYSTEM", SECURITY.md).
- The tf-* services were switched manually via `nssm edit`; that setting persists.

Re-check with:

```
powershell -c "Get-CimInstance Win32_Service | ? { $_.PathName -match 'nssm' } | select Name,StartName,State"
```

### What Warden does with Log On today

- Never reads or sets `ObjectName`; not referenced anywhere in `src/`.
- Settings page (`src/routes/settings.ts`, `PARAMS`) reads/edits 9 params; Log On is not one.
- Install (`src/routes/services.ts`, settings list) does not set it, so Warden-installed services default to LocalSystem.
- `nssm-install.bat` does not set it either.

## Options considered

### A. Show only (smallest)

- Settings page: one extra `nssmGet(name, 'ObjectName')` per page load; add to the read-only area. Cheap.
- Dashboard column: costs one call per service per poll, unless batched (single `sc qc` per service is no better; one `Get-CimInstance Win32_Service` / WMI query returns all `StartName` at once, but that is a new spawn type).
- Value: answers "which account is this running as?" at the moment of a path/profile bug.
- Objection raised: "why show it if it cannot be set?" Answer: diagnosis. The bugle issue was solved by knowing the account, not by changing it.

### B. Show and set

- `nssm set <svc> ObjectName LocalSystem` - no password.
- `nssm set <svc> ObjectName .\user <password>` - **requires the account password**.
- Implications:
	- Warden (LocalSystem) would accept a password via form and pass it to nssm. Pass-through only; do not store.
	- Should be its own permission (not folded into general settings edit), audited.
	- Account needs "Log on as a service" right; verify whether nssm grants it automatically when setting ObjectName.
	- Changing the account changes profile paths (`%USERPROFILE%`, `%APPDATA%`), registry hive, and file ACL access - exactly the class of bug that triggered this note. Consider a warning on change.
	- Changing Warden's own account away from LocalSystem would break its ability to install/remove services. Guard or refuse for self (`isSelf`).
	- Restart required for the change to take effect.

### C. Do nothing (chosen for now)

Usage is rare (4 services, set once by hand). Revisit when the account needs to change or a second account-related bug appears.

## Open questions for later

- Show on settings page only, or also dashboard?
- If set is built: allow arbitrary accounts, or a configured allowlist (e.g. `LocalSystem`, `.\taskflow`)?
- Should Warden's install form offer Log On at install time?
