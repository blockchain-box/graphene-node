FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json /app/package.json
COPY network/ /app/network/
COPY agents/lib/ /app/agents/lib/

RUN npm install

COPY agents/sentry-agent/package.json /app/agents/sentry-agent/package.json
RUN npm install --prefix agents/sentry-agent --no-save

COPY agents/sentry-agent/src/ /app/agents/sentry-agent/src/

RUN mkdir -p /app/secrets /app/logs /app/state

COPY agents/sentry-agent/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "agents/sentry-agent/src/cli.js", "start"]
