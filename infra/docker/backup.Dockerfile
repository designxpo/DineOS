# Backup runner with pg_dump 16, openssl, rsync and the AWS CLI for an S3-compatible second location.
FROM postgres:16-alpine
RUN apk add --no-cache bash openssl rsync openssh-client aws-cli nodejs
COPY infra/backup /opt/mezmitra/backup
COPY apps/api/migrations /opt/mezmitra/migrations
ENV MIGRATIONS_DIR=/opt/mezmitra/migrations BACKUP_DIR=/backups
ENTRYPOINT ["/opt/mezmitra/backup/backup.sh"]
