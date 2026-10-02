-- domains-db: the databases of the v2 services, co-hosted on one Postgres instance in the local stack
-- (ADR-12, docs/v2/03-architecture.md §7). Each service gets its own database and its own role; a role can
-- connect only to its own database, so autonomy holds at database level. In the Swarm stack every service
-- gets its own Postgres instance instead, like v1.
--
-- Runs once, when the volume is empty (docker-entrypoint-initdb.d). Adding a service later: add its block
-- here AND create it by hand in an existing volume (psql -U domains), or recreate the domains-db volume.
-- Development credentials: role = password = database name, like the v1 databases in compose.yaml.

-- the instance's own databases hold no service data – only the superuser uses them
REVOKE CONNECT, TEMPORARY ON DATABASE domains, postgres FROM PUBLIC;

CREATE ROLE trigger LOGIN PASSWORD 'trigger';
CREATE DATABASE trigger OWNER trigger;
REVOKE CONNECT, TEMPORARY ON DATABASE trigger FROM PUBLIC;

CREATE ROLE today LOGIN PASSWORD 'today';
CREATE DATABASE today OWNER today;
REVOKE CONNECT, TEMPORARY ON DATABASE today FROM PUBLIC;

CREATE ROLE connector LOGIN PASSWORD 'connector';
CREATE DATABASE connector OWNER connector;
REVOKE CONNECT, TEMPORARY ON DATABASE connector FROM PUBLIC;

CREATE ROLE delivery LOGIN PASSWORD 'delivery';
CREATE DATABASE delivery OWNER delivery;
REVOKE CONNECT, TEMPORARY ON DATABASE delivery FROM PUBLIC;

CREATE ROLE assistant LOGIN PASSWORD 'assistant';
CREATE DATABASE assistant OWNER assistant;
REVOKE CONNECT, TEMPORARY ON DATABASE assistant FROM PUBLIC;

CREATE ROLE budget LOGIN PASSWORD 'budget';
CREATE DATABASE budget OWNER budget;
REVOKE CONNECT, TEMPORARY ON DATABASE budget FROM PUBLIC;

CREATE ROLE health LOGIN PASSWORD 'health';
CREATE DATABASE health OWNER health;
REVOKE CONNECT, TEMPORARY ON DATABASE health FROM PUBLIC;

CREATE ROLE people LOGIN PASSWORD 'people';
CREATE DATABASE people OWNER people;
REVOKE CONNECT, TEMPORARY ON DATABASE people FROM PUBLIC;

CREATE ROLE home LOGIN PASSWORD 'home';
CREATE DATABASE home OWNER home;
REVOKE CONNECT, TEMPORARY ON DATABASE home FROM PUBLIC;

CREATE ROLE calendar LOGIN PASSWORD 'calendar';
CREATE DATABASE calendar OWNER calendar;
REVOKE CONNECT, TEMPORARY ON DATABASE calendar FROM PUBLIC;
