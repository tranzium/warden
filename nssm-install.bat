@echo off
REM Warden NSSM service installer
REM Run as Administrator. Edit variables at the top before running.
REM Requires: nssm.exe on PATH (https://nssm.cc — on Windows 10 Creators Update
REM and newer, use the 2.24-101 prerelease; stable 2.24 fails to start services)

set SERVICE=warden
set BUN=D:\bin\bun.exe
set WORKDIR=D:\projects\warden
set LOGDIR=D:\logs\warden

REM ---- pre-flight checks ----
if not exist "%BUN%" ( echo ERROR: BUN not found: %BUN% & exit /b 1 )
if not exist "%WORKDIR%\src\server.ts" ( echo ERROR: WORKDIR not found: %WORKDIR% & exit /b 1 )

REM ---- install ----
nssm install %SERVICE% "%BUN%" "run src/server.ts"
nssm set %SERVICE% AppDirectory "%WORKDIR%"
nssm set %SERVICE% DisplayName "Warden"
nssm set %SERVICE% Description "Warden - Windows service control panel"
nssm set %SERVICE% Start SERVICE_AUTO_START

REM Stdout / Stderr logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
nssm set %SERVICE% AppStdout "%LOGDIR%\stdout.log"
nssm set %SERVICE% AppStderr "%LOGDIR%\stderr.log"
nssm set %SERVICE% AppRotateFiles 1
nssm set %SERVICE% AppRotateOnline 1
nssm set %SERVICE% AppRotateBytes 10485760

REM Restart policy: 5 s delay, always restart on exit
nssm set %SERVICE% AppRestartDelay 5000
nssm set %SERVICE% AppExit Default Restart

REM ---- environment ----
REM Edit the values below before running. Generate AUTH_PASSWORD_HASH with
REM `bun run scripts/hash-password.ts <password>` — NSSM's AppEnvironmentExtra
REM stores it as-is (no shell expansion), so paste the hash unescaped here,
REM unlike the backslash-escaped form used in a .env file (see .env.example).
REM To defer auth to an Orbit tenant instead, set AUTH_MODE=orbit and its
REM ORBIT_*/OAUTH_* variables — see docs/orbit-setup.md.
nssm set %SERVICE% AppEnvironmentExtra ^
    "AUTH_MODE=local" ^
    "AUTH_USERNAME=admin" ^
    "AUTH_PASSWORD_HASH=change-me" ^
    "COOKIE_SECRET=change-me-32-chars-minimum-required" ^
    "PORT=3004" ^
    "HOST=127.0.0.1" ^
    "DB_PATH=./data/warden.db"

echo Service "%SERVICE%" installed.
echo Start with: nssm start %SERVICE%
