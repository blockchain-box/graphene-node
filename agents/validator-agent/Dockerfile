FROM node:lts-alpine

WORKDIR /app

RUN apk add --no-cache bash curl

COPY package.json /app/package.json
COPY network/ /app/network/

RUN npm install

COPY agents/validator-agent/package.json /app/agents/validator-agent/package.json
RUN npm install --prefix agents/validator-agent --no-save

COPY agents/validator-agent/src/ /app/agents/validator-agent/src/

RUN mkdir -p /app/secrets /app/logs

COPY agents/validator-agent/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "agents/validator-agent/src/cli.js", "connect"]
