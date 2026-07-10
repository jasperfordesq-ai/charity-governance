\set ON_ERROR_STOP on

-- Values come from the private runner-generated env file. There are no
-- committed credentials or reusable instance identifiers in this script.
\getenv runner_password E2E_DATABASE_RUNNER_PASSWORD
\getenv instance_id E2E_DATABASE_INSTANCE_ID

CREATE ROLE charitypilot_e2e_runner
  LOGIN
  PASSWORD :'runner_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

CREATE DATABASE charitypilot_e2e_disposable
  OWNER charitypilot_e2e_bootstrap
  TEMPLATE template0
  ENCODING 'UTF8';

COMMENT ON DATABASE charitypilot_e2e_disposable IS
  'CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1';

REVOKE ALL ON DATABASE charitypilot_e2e_disposable FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE charitypilot_e2e_disposable
  TO charitypilot_e2e_runner;

\connect charitypilot_e2e_disposable

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO charitypilot_e2e_runner;
ALTER ROLE charitypilot_e2e_runner IN DATABASE charitypilot_e2e_disposable
  SET search_path TO public;

CREATE SCHEMA charitypilot_e2e_guard AUTHORIZATION charitypilot_e2e_bootstrap;
REVOKE ALL ON SCHEMA charitypilot_e2e_guard FROM PUBLIC;

CREATE TABLE charitypilot_e2e_guard.database_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  marker_version integer NOT NULL CHECK (marker_version = 1),
  purpose text NOT NULL CHECK (purpose = 'charitypilot-e2e-disposable'),
  instance_id uuid NOT NULL
);

INSERT INTO charitypilot_e2e_guard.database_identity (
  singleton,
  marker_version,
  purpose,
  instance_id
) VALUES (
  true,
  1,
  'charitypilot-e2e-disposable',
  :'instance_id'::uuid
);

REVOKE ALL ON TABLE charitypilot_e2e_guard.database_identity FROM PUBLIC;
GRANT USAGE ON SCHEMA charitypilot_e2e_guard TO charitypilot_e2e_runner;
GRANT SELECT ON TABLE charitypilot_e2e_guard.database_identity
  TO charitypilot_e2e_runner;

-- Fail the one-time bootstrap if the destructive-test role is more privileged
-- than its narrow contract or can mutate the protected marker.
DO $$
DECLARE
  role_state record;
  membership_count integer;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
    INTO role_state
    FROM pg_roles
    WHERE rolname = 'charitypilot_e2e_runner';

  IF role_state IS NULL
     OR role_state.rolsuper
     OR role_state.rolcreatedb
     OR role_state.rolcreaterole
     OR role_state.rolreplication
     OR role_state.rolbypassrls
     OR role_state.rolinherit THEN
    RAISE EXCEPTION 'CharityPilot E2E runner role has unsafe attributes';
  END IF;

  SELECT COUNT(*)::int
    INTO membership_count
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS role ON role.oid = membership.member OR role.oid = membership.roleid
    WHERE role.rolname = 'charitypilot_e2e_runner';
  IF membership_count <> 0 THEN
    RAISE EXCEPTION 'CharityPilot E2E runner has unsafe role memberships';
  END IF;

  IF pg_catalog.pg_get_userbyid((SELECT datdba FROM pg_catalog.pg_database WHERE datname = current_database())) = 'charitypilot_e2e_runner'
     OR pg_catalog.pg_get_userbyid((SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'charitypilot_e2e_guard')) = 'charitypilot_e2e_runner'
     OR (
       SELECT pg_catalog.pg_get_userbyid(relowner)
       FROM pg_catalog.pg_class
       WHERE oid = 'charitypilot_e2e_guard.database_identity'::regclass
     ) = 'charitypilot_e2e_runner' THEN
    RAISE EXCEPTION 'CharityPilot E2E runner owns protected identity objects';
  END IF;

  IF has_schema_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard', 'CREATE') THEN
    RAISE EXCEPTION 'CharityPilot E2E runner can create objects in the protected marker schema';
  END IF;

  IF has_table_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard.database_identity', 'INSERT')
     OR has_table_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard.database_identity', 'UPDATE')
     OR has_table_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard.database_identity', 'DELETE')
     OR has_table_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard.database_identity', 'TRUNCATE')
     OR has_table_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard.database_identity', 'REFERENCES')
     OR has_table_privilege('charitypilot_e2e_runner', 'charitypilot_e2e_guard.database_identity', 'TRIGGER') THEN
    RAISE EXCEPTION 'CharityPilot E2E runner can mutate the protected marker';
  END IF;
END
$$;

-- The generated bootstrap credential exists only for one-time init. Ownership
-- remains separated from the destructive runner, but the owner cannot log in.
ALTER ROLE charitypilot_e2e_bootstrap NOLOGIN;
