FROM postgres:18-alpine

WORKDIR /postgresql

# Copy initialization script
COPY docker/db/init-app-users.sh /docker-entrypoint-initdb.d/init-app-users.sh

COPY health/healthcheck-db.sh healthcheck.sh

# Ensure script is executable
RUN chmod +x /docker-entrypoint-initdb.d/init-app-users.sh
RUN chmod +x /postgresql/healthcheck.sh
