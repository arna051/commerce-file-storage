FROM golang:1.24.8-bookworm AS build
ARG MINIO_REF=7aac2a2c5b7c882e68c1ce017d8256be2feea27f
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=$GOPROXY
RUN git clone https://github.com/minio/minio.git /src/minio \
  && cd /src/minio \
  && git checkout "$MINIO_REF" \
  && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/minio .

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home /data minio
COPY --from=build /out/minio /usr/local/bin/minio
COPY --chmod=755 docker/minio/entrypoint.sh /usr/local/bin/minio-entrypoint
EXPOSE 9000 9001
ENTRYPOINT ["minio-entrypoint"]
