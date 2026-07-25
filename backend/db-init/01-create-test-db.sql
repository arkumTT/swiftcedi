-- Runs automatically on first container start (docker-entrypoint-initdb.d)
-- to provision a second, disposable database for `npm test`'s integration suite.
CREATE DATABASE swiftcedi_test OWNER swiftcedi;
