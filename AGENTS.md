# graphene-node

Node.js deployment monorepo for Graphene network nodes (validator + sentry). Docker Compose-based, wired to local `@grph-net/*` workspace dependencies.

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/<feature>/`. See `../docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `../docs/agents/triage-labels.md`.

### Domain docs

Multi-context — see `../CONTEXT-MAP.md` for per-project contexts. See `../docs/agents/domain.md`.

## Commands

```bash
sh deploy.sh local                # deploy full local environment (Docker Compose)
```

## Structure

```
graphene-node/
├── deploy.sh          # main entry point
├── docker/            # Docker Compose and Dockerfiles
├── chain/             # Tendermint chain configs
├── network/           # local deps → @grph-net/*
├── services/          # agent services
├── config/            # app configuration
├── health/            # health endpoints
├── scripts/           # utility scripts
└── secrets/           # local secrets (gitignored)
```

No test or lint commands defined. Deployment is Docker-based.
