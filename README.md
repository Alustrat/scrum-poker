# scrum-poker

Create rooms to estimate your tasks with your colleagues, in real time.

## Features

- Create a room, optionally protected by a password set by the creator
- Join a room and vote on a story using a standard Fibonacci deck (0, 1, 2, 3, 5, 8, 13, 21, ?, ☕)
- See who has voted in real time; votes stay hidden until anyone in the room reveals them
- Start a new round to clear votes and estimate the next story
- Inactive rooms (no activity for 15 days) are deleted automatically

Chat within a room is planned as a follow-up feature.

## Limits

To keep the service from being overwhelmed by a single bad actor, the server enforces:

- **20 participants per room**, **5 connections per participant** (multi-tab), and **1,000 rooms in parallel** — all checked atomically under a Redis lock so concurrent joins/creations can't race past the cap
- **20 room creations per hour per IP address**
- Room names, display names, and passwords are length-capped, and votes must be one of the deck's actual values
- Rate limits and hard caps are configurable via `MAX_ROOMS`, `MAX_PARTICIPANTS_PER_ROOM`, `MAX_SOCKETS_PER_PARTICIPANT`, and `MAX_ROOM_CREATIONS_PER_HOUR` (see `.env.example`)

## Tech stack

- **Client**: React + TypeScript, built with Vite
- **Server**: Node.js + TypeScript, Express (REST) + Socket.IO (realtime)
- **Storage**: PostgreSQL, run via Docker — stores only room metadata (name, password hash, last activity)
- **Live session state**: Redis, run via Docker — stores participants and votes for each room, and backs the Socket.IO Redis adapter for cross-instance broadcast. This is what lets the app run multiple server instances behind a load balancer (configuring such a deployment is outside the scope of this repo, but the code supports it).
- One process serves both the API/WebSocket layer and the built client, so the whole app deploys as a single container/service (and can be scaled to multiple, sharing Postgres/Redis)

## Project structure

```
client/   React app (Vite)
server/   Express + Socket.IO backend, PostgreSQL + Redis persistence
```

## Getting started

Requires Docker.

```
cp .env.example .env
docker compose up -d --build
```

This starts the `postgres`, `redis`, and `app` services, and serves the app at `http://localhost:3001`. Postgres data is written to a named volume (`postgres-data`), so rooms persist across restarts. Redis has no volume — live session state is ephemeral by design (a restart just means everyone reconnects and revotes).

Adjust `.env` before starting the stack if you need different ports, credentials, or a specific `CLIENT_ORIGIN`; it's gitignored and read automatically by `docker compose`.

## Local development

For hot-reload during development, run the app outside Docker while keeping Postgres and Redis in containers. Requires Node.js 20+.

```
npm install
docker compose up -d postgres redis
npm run dev
```

This runs the server on `http://localhost:3001` and the Vite dev server on `http://localhost:5173` (which proxies `/api` and `/socket.io` to the backend). The server connects to Postgres on `localhost:5432` and Redis on `localhost:6379` by default — start those containers before `npm run dev` (and before `npm test`).

## Production build

```
npm run build
npm start
```

`npm run build` builds the client and compiles the server; `npm start` runs the compiled server, which also serves the built client on a single port (`PORT`, default `3001`).
