@echo off
REM Warden NSSM service installer
REM Run as Administrator. Edit variables at the top before running.
REM Requires: nssm.exe on PATH (https://nssm.cc)

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
nssm set %SERVICE% Description "Warden — Windows service control panel with Orbit auth"
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
REM Edit the values below before running.
nssm set %SERVICE% AppEnvironmentExtra ^
    "ORBIT_INTROSPECT_URL=http://127.0.0.1:3000" ^
    "ORBIT_API_KEY=change-me" ^
    "ORBIT_TENANT_ID=change-me" ^
    "OAUTH_CLIENT_ID=change-me" ^
    "OAUTH_CLIENT_SECRET=" ^
    "OAUTH_REDIRECT_URI=https://warden.wrift.ca/callback" ^
    "OAUTH_AUTHORIZE_URL=https://oauth.wrift.ca/oauth2/authorize" ^
    "OAUTH_TOKEN_URL=https://oauth.wrift.ca/oauth2/token" ^
    "COOKIE_SECRET=change-me-32-chars-minimum-required" ^
    "PORT=3004" ^
    "DB_PATH=./data/warden.db"

echo Service "%SERVICE%" installed.
echo Start with: nssm start %SERVICE%
