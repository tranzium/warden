# Log On live check

`scripts/logon-live-check.ts` proves Warden's service Log On path against real NSSM and Windows: account lookup, `nssm set <svc> ObjectName <account> <password>`, and that the password arrives intact. CI cannot do this (no NSSM, no admin), so run it by hand after changing `src/nssm/logon.ts` or the settings save flow.

## Prerequisites

- An **elevated** (Run as administrator) command prompt.
- `nssm` on `PATH`, or `NSSM_PATH` set.
- No existing local account or NSSM service named `warden-logon-test`.

## Run

From the repo root:

```
bun run scripts/logon-live-check.ts          (dry run: prints the steps, changes nothing)
bun run scripts/logon-live-check.ts --live   (does the check)
```

Without `--live` it never changes anything. With `--live` it refuses to run unless elevated, and refuses if `warden-logon-test` already exists.

## What it creates and removes

| Created | Removed at the end |
|---|---|
| Local account `warden-logon-test` | Yes (`Remove-LocalUser`) |
| NSSM service `warden-logon-test` (`PING.EXE -n 3600 127.0.0.1`, manual start) | Yes (`nssm remove`) |
| User profile (created when the service starts under the account) | Yes (`Win32_UserProfile`) |
| "Log on as a service" entry (granted by NSSM) | **No** - reported only. Harmless orphaned SID; remove via secpol.msc > User Rights Assignment if wanted. |

Cleanup runs in `finally`, so it also runs after a failed check.

## What it checks

- `.\warden-logon-test` resolves via the lookup.
- Five passwords with spaces, `"`, trailing `\`, `%`, `^` and `&`: each applied through Warden's `planLogon` / `applyLogon`, `ObjectName` reads back as the account, and the service actually **starts** under it (a mangled password fails with a logon error).
- `./warden-logon-test` is rejected with the backslash suggestion before NSSM is called, and `ObjectName` is unchanged.
- A wrong password is accepted by NSSM but the service fails to start.
- NSSM granted "Log on as a service" (read from a `secedit /export`, never `secedit /configure`).
- Switching back to LocalSystem works.
- No password appears in any NSSM or Warden output.

## Expected result

One `PASS` / `FAIL` line per check, then:

```
logon-live-check: N/N passed
```

Exit code 0 when everything passed, 1 otherwise.
