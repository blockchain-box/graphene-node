# ---- build stage ----
FROM --platform=$BUILDPLATFORM golang:1.19-alpine AS builder

ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

RUN apk add --no-cache git make

WORKDIR /src
RUN git clone https://github.com/Anas2001/tendermint.git .

ENV CGO_ENABLED=0
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} make build

# ---- runtime stage ----
FROM alpine:3.18

ENV MONIKER=graphene-peer-node \
    CHAIN_ID=graphene-testnet \
    TMHOME=/tendermint

WORKDIR /tendermint

RUN apk add --no-cache ca-certificates bash \
    && mkdir -p /tendermint/config /tendermint/data

COPY --from=builder /src/build/tendermint /usr/bin/tendermint

COPY health/healthcheck-tendermint.sh /healthcheck.sh
RUN chmod +x /healthcheck.sh

COPY docker/validator/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 26656 26657 26660

ENTRYPOINT ["/entrypoint.sh"]
CMD ["tendermint", "version"]
