#!/bin/sh
# Deletes database backups (~/swipy-backup-*.sql) older than 30 days, as the privacy policy promises.
# Run with --dry-run to only list them. BACKUP_DIR and KEEP_DAYS exist so it can be tried on a scratch folder.
dir="${BACKUP_DIR:-$HOME}"
days="${KEEP_DAYS:-30}"
if [ "$1" = "--dry-run" ]; then
  find "$dir" -maxdepth 1 -name 'swipy-backup-*.sql' -mtime "+$days" -print
else
  find "$dir" -maxdepth 1 -name 'swipy-backup-*.sql' -mtime "+$days" -print -delete
fi
