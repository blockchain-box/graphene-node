FROM postgres:18-alpine

# Optional working directory for scripts
WORKDIR /postgresql

# Copy init script
COPY docker/db/init-app-users.sh /docker-entrypoint-initdb.d/init-app-users.sh

# Copy healthcheck script
COPY health/healthcheck-db.sh healthcheck.sh

# Ensure scripts are executable
RUN chmod +x /docker-entrypoint-initdb.d/init-app-users.sh \
    && chmod +x /postgresql/healthcheck.sh
