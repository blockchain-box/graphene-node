FROM registry.access.redhat.com/ubi9/ubi-minimal:9.7

WORKDIR /app

COPY --chown=1001:root --chmod=0755 chain/grph-abci node
COPY --chown=1001:root --chmod=0755 health/healthcheck-abci.sh healthcheck.sh

EXPOSE 3002 26658
USER 1001

ENTRYPOINT ["/app/node", "-Dquarkus.http.host=0.0.0.0"]
