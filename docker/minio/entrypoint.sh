#!/bin/sh
set -eu
chown -R minio:nogroup /data
exec runuser -u minio -- /usr/local/bin/minio "$@"
