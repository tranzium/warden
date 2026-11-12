# Service Log On account - design

Date: 2026-11-11. Branch: `feat/service-logon`. Background and findings: `docs/notes/2026-11-11-service-logon-account.md`.

## Intent

Let a Warden user see, and change, the Windows account an NSSM service runs as (NSSM `ObjectName`, services.msc "Log On") from the existing service settings page.

Why: two real incidents.

1. `bugle` used a path under the `Devan` profile while running as `.\taskflow`. Diagnosis was slow because nothing showed the run-as account.
2. Setting `chief` to `.\Devan` via `nssm edit` failed twice: `Failed to look up the SID for username ./Devan!` (forward slash), then `ChangeServiceConfig(): The parameter is incorrect.` (cause unknown). A confirm-password match indicator and an up-front account check would have helped.

## Goals

- Settings page shows the service's current Log On account.
- Settings page can change it: Local System, or a named account with password.
- Password entry mirrors the `nssm edit` dialog: password + confirm, with a live "passwords match" indicator; Save disabled while they differ.
- Catch a bad account name before calling NSSM (e.g. `./Devan`), and surface NSSM/Windows error text verbatim when the change fails.

## Non-goals

- No header changes, no tabs, no Log On badge on the settings or logs page header. (User chose "A": keep the header as is.)
- No Log On column on the dashboard.
- No Log On choice in the install form / `POST /services` / `nssm-install.bat`.
- No verifying the password against Windows (no `LogonUser`); it would count toward account lockout. "Matches" means password == confirm only.
- No LocalService / NetworkService / virtual / gMSA account choices in the UI.
- No direct Win32 API calls (Bun FFI). NSSM is the only mechanism, like the rest of Warden, to stay agnostic about the host Warden runs on.
- No new permission.
- No new restart warning; the existing notice box above Save already says changes apply on restart and offers "restart now".

## Anti-goals (would be a failure even if it works)

- The password appears anywhere besides the single NSSM invocation: DB, logs, stdout/stderr, audit, error flash, redirect URL, rendered HTML (including `value=` on re-render).
- The browser autofills the signed-in user's own saved password into the field.
- Warden can move itself off LocalSystem from its own settings page.
- Saving any other setting re-applies or clears Log On when the user did not touch it.

## Decided (by the user)

- Location: a new "Log on" card on the existing settings form, placed last, directly above the existing notice/restart box. Same form, same Save button.
- Header unchanged (title + Logs button).
- Confirm field with match indicator, like the `nssm edit` modal.
- Use NSSM (`nssm set <svc> ObjectName ...`) for the change, accepting that the password is briefly on that process's command line. Rationale: consistency and host-agnosticism.

## Behavior

### Card

- Header: "Log on", plus "Currently: `<ObjectName>`" (as read from NSSM).
- Two radio options, mirroring `nssm edit`: "Local System account" / "This account".
- "This account" shows: Account (text), Password, Confirm password. Hidden when Local System is selected.
- Initial state: Local System selected when current `ObjectName` is `LocalSystem`; otherwise "This account" with Account prefilled to current value, password fields empty.
- Password fields: `type=password`, `autocomplete=new-password`, never prefilled. Placeholder conveys "leave blank to keep current".
- Match indicator under Confirm: blank when both empty; "Passwords match" / "Passwords do not match" otherwise. Save disabled while they differ.
- Account hint under Account: on blur, server lookup shows "Resolves to `MACHINE\name`" or "Account not found". If input starts with `./`, hint suggests the backslash form.
- Short note: password is sent once to Windows and not stored; required when changing the account.
- For Warden itself (`isSelf`): card shows current account read-only, with no inputs and a one-line reason (changing it would break install/remove).

### Save

Evaluated after the existing settings are validated; Log On is applied as one more "only if changed" step in the existing save flow.

| Selection | Account vs current | Password | Result |
|---|---|---|---|
| Local System | current is LocalSystem | - | no change |
| Local System | current is other | - | `nssm set <svc> ObjectName LocalSystem` |
| This account | same | blank | no change |
| This account | same | entered | re-apply account with new password (password rotation) |
| This account | different | blank | error: password required when changing the account |
| This account | any | entered, confirm differs | error: passwords do not match (server re-checks) |

Before calling NSSM for a named account:
- Normalize a leading `./` to `.\`.
- Resolve the account name; if it does not resolve, fail with "Account not found: <name>" and do not call NSSM.

NSSM grants "Log on as a service" itself (observed: "The 'Log on as a service' right was granted to account PICKWICKDRIVE\Devan."). Warden does not grant rights.

On NSSM failure, show NSSM's output verbatim in the existing error alert (e.g. `ChangeServiceConfig(): The parameter is incorrect.`). The password is never part of the message.

Server rejects any Log On change for Warden itself regardless of what the form posts.

### Permission

Reuse `services.install` (already gates the settings page and save). Rationale: it already permits running an arbitrary program as SYSTEM, so lowering a service to a named account adds no capability; a new permission would require Orbit tenant changes.

### Security notes to document

Add to `SECURITY.md`:
- Log On change exists, is gated by `services.install`, and is refused for Warden itself.
- Password is passed to `nssm set ... ObjectName <account> <password>` and so is on that short-lived process's command line. Readable live only by admins/SYSTEM (Warden runs as LocalSystem). Persisted if the host enables process command-line auditing (event 4688 with `ProcessCreationIncludeCmdLine_Enabled`) or Sysmon/EDR command-line logging. On the current host neither is enabled (checked 2026-11-11).
- Windows stores the password as an LSA secret (same as services.msc); Warden stores nothing.
- Recommend HTTPS / localhost-only exposure, since the password crosses the wire once in the form post.

## Constraints

- Bun + TypeScript, server-rendered HTML views, Bootstrap 5 (existing patterns in `src/views/settings.ts`, `src/routes/settings.ts`).
- NSSM via existing `src/nssm/client.ts` (`nssmGet`, `nssmSet`).
- CI: `windows-latest`, `bunx tsc --noEmit` + `bun run test` (smoke scripts); no NSSM or admin there. Project rule: production implementations in tests, no mocks; prefer pure functions so decision logic is testable without NSSM.
- Repo conventions: tabs, CRLF best effort, no version bump.

## Verification

- CI (no NSSM, no admin): typecheck + tests of the pure decision logic (save table, `./` normalization, password/confirm rules, "password never in error/redirect" checks) using production code, no mocks.
- Live check (user approved 2026-11-11): a repo script, `scripts/logon-live-check.ts`, run once by the user from an **elevated** prompt (the dev session is not elevated). Not part of `bun run test`. It:
	1. Creates a throwaway local account and a throwaway NSSM service (a harmless long-running program).
	2. Drives Warden's real Log On code path (lookup + `nssm set ... ObjectName`) with tricky passwords: spaces, double quotes, trailing backslash, `%`, `^`, `&`.
	3. Proves each password reached Windows intact by starting the service under the account (a wrong password fails with logon error 1069), then stopping it.
	4. Checks account resolution: `./name` normalization, unknown account rejected before NSSM is called.
	5. Checks NSSM output / Warden error text never contains the password.
	6. Confirms "Log on as a service" was granted by NSSM.
	7. Always cleans up (finally): remove service, delete the account, remove its user profile (created by step 3), and remove the account's leftover "Log on as a service" entry if practical; otherwise report it as harmless (orphaned SID in local policy).
	8. Prints a pass/fail summary, ASCII only.
- Dry-run by default: the script refuses to make changes unless passed an explicit live flag; without it, it prints what it would do.

## Left to the builder

- How account resolution is done without FFI (e.g. a spawned Windows tool), including how `.\name` maps to the local machine.
- Shape of the on-blur lookup endpoint (route, response), gated by `services.install`.
- Exact wording of hints, placeholders and errors.
- Where the pure decision logic lives (table above) and how it is tested; whether tests extend the smoke scripts or add a test file.
- Whether `ObjectName` joins the existing `PARAMS` read list or is read separately.
- Client-side JS: inline or a small static file, following existing patterns.

## My calls (not explicitly confirmed by the user)

- Reuse `services.install` instead of a new permission.
- Read-only card for Warden itself.
- Password rotation allowed (same account + new password re-applies).
- `./` auto-normalized to `.\`.
- On-blur account lookup hint (server-side), in addition to the check on save.
- Only Local System and named accounts offered.
- No diagnosis of unknown `ChangeServiceConfig` failures: success criterion is "catch bad names early, show NSSM's error verbatim". (`chief` now runs as `.\Devan`, so the failure in incident 2 was transient or input-related, not a blocker.)
- No audit record for Log On changes, consistent with every other dashboard settings save (only the `/v1` agent API audits today). `SECURITY.md` states that Log On changes are not recorded.
- No dry-run mode: the settings page is a human form whose saves already apply live; dry-run-by-default stays the rule for the agent API. Testing during the build is what follows the dry-run rule (see Verification).
- Mockup shown during design: `https://viz.devan.pw/display/v_0c64ed20-878f-43e3-9921-f4410174c939` (option A).
