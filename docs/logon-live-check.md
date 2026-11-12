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
| User profile (created when the service starts under the account) | Retried for 30s (`Win32_UserProfile`); commonly still fails - see below |
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

Exit code 0 when everything passed, 1 otherwise. A known, accepted exception: `cleanup:
remove user profile` routinely FAILs ("being used by another process") because `WSearch`,
`WinDefend`, or `SysMain` opens a handle into the newly created profile's registry hive
(indexing/scanning it) and Windows will not unmount it until they let go - sometimes well
past 30s. Confirmed on 2026-11-12: not a bug in this feature, every other check (the one
that matters for the Log On path) passed clean. Remove the orphaned profile later via
`Get-CimInstance Win32_UserProfile | Where-Object SID -eq '<sid>' | Remove-CimInstance`,
same as the leftover logon-right SID.
