-- Connector credentials are structurally separated from serving data. Runtime
-- roles are provisioned once by an administrator; this per-database migration
-- remains safe for operators whose migration identity lacks CREATEROLE.
CREATE SCHEMA IF NOT EXISTS secrets;
REVOKE ALL ON SCHEMA secrets FROM PUBLIC;

CREATE TABLE IF NOT EXISTS secrets.connector_credentials (
  tenant text NOT NULL,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_version integer NOT NULL CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, name)
);

REVOKE ALL ON ALL TABLES IN SCHEMA secrets FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA secrets FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA secrets FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA secrets REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA secrets REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA secrets REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- Deployments provision these roles before migration. Local/PGlite catalogs do
-- not need them, so grants are deliberately conditional rather than magical.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eil_api') THEN
    REVOKE ALL ON SCHEMA secrets FROM eil_api;
    REVOKE ALL ON ALL TABLES IN SCHEMA secrets FROM eil_api;
    ALTER DEFAULT PRIVILEGES IN SCHEMA secrets REVOKE ALL ON TABLES FROM eil_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eil_connector_worker') THEN
    GRANT USAGE ON SCHEMA secrets TO eil_connector_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON secrets.connector_credentials TO eil_connector_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA secrets
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eil_connector_worker;
  END IF;
END
$$;
