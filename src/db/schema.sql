CREATE TABLE IF NOT EXISTS services (
	id          TEXT PRIMARY KEY,
	name        TEXT UNIQUE NOT NULL,
	display     TEXT,
	description TEXT,
	group_name  TEXT,
	managed     INTEGER DEFAULT 1,
	created_at  TEXT DEFAULT (datetime('now'))
);
