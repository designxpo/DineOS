# Backup runner with pg_dump 16, openssl, rsync and the AWS CLI for an S3-compatible second location.
FROM postgres:16-alpine
RUN apk add --no-cache bash openssl rsync openssh-client aws-cli nodejs
COPY infra/backup /opt/dineos/backup
COPY apps/api/migrations /opt/dineos/migrations
ENV MIGRATIONS_DIR=/opt/dineos/migrations BACKUP_DIR=/backups
ENTRYPOINT ["/opt/dineos/backup/backup.sh"]
