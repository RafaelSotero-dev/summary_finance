# Revocable server-side sessions

The application will replace its stateless signed session cookie with opaque sessions persisted in PostgreSQL. This makes logout revoke the current session at the server, permits one-time magic links, and preserves the eight-hour fixed session lifetime without exposing session credentials to the React application.
