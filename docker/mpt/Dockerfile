FROM node:lts-alpine

WORKDIR /app

COPY dependencies/package.json /app/package.json
COPY dependencies/package-lock.json /app/package-lock.json
COPY chain/mpt.db.js /app/mpt.db.js
COPY health/healthcheck.js /app/healthcheck.js
COPY docker/mpt/start.mjs /app/start.mjs
COPY docker/mpt/openapi.yml /openapi.yml

RUN npm ci --only=production

# Expose the port the app runs on
EXPOSE 3000

CMD ["node", "/app/start.mjs"]
