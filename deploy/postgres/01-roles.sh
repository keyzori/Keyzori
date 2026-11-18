#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv server_password KZ_SERVER_DATABASE_PASSWORD
\getenv migration_password KZ_MIGRATION_DATABASE_PASSWORD
\getenv database_name POSTGRES_DB
CREATE ROLE keyzori_server LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'server_password';
CREATE ROLE keyzori_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migration_password';
ALTER ROLE keyzori_server SET search_path = public, pg_catalog;
ALTER ROLE keyzori_migrator SET search_path = public, pg_catalog;
\set runtime_login keyzori_server
\set schema_owner keyzori_migrator
-- keyzori_server is the canonical runtime privilege grantee, and may also be a
-- NOLOGIN role inherited by a separate runtime login.
-- Database-local provisioning follows.
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_login", :"schema_owner";
ALTER SCHEMA public OWNER TO :"schema_owner";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO keyzori_server;
CREATE SCHEMA drizzle AUTHORIZATION :"schema_owner";
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;
GRANT USAGE ON SCHEMA drizzle TO keyzori_server;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO keyzori_server;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO keyzori_server;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA drizzle REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA drizzle REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA drizzle GRANT SELECT ON TABLES TO keyzori_server;
SQL
