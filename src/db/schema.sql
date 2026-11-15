CREATE TABLE IF NOT EXISTS services (
	id          TEXT PRIMARY KEY,
	name        TEXT UNIQUE NOT NULL,
	display     TEXT,
	description TEXT,
	group_name  TEXT,
	managed     INTEGER DEFAULT 1,
	hidden      INTEGER DEFAULT 0,
	created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_access_requests (
	id           TEXT PRIMARY KEY,
	token_name   TEXT NOT NULL,
	service_name TEXT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied'
	reason       TEXT,
	requested_at TEXT DEFAULT (datetime('now')),
	decided_at   TEXT,
	decided_by   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
	id           TEXT PRIMARY KEY,
	access_token TEXT NOT NULL,
	user_id      TEXT NOT NULL,
	email        TEXT NOT NULL,
	name         TEXT NOT NULL,
	grants       TEXT NOT NULL,
	created_at   TEXT DEFAULT (datetime('now')),
	expires_at   TEXT NOT NULL,
	refreshed_at TEXT DEFAULT (datetime('now'))
);
