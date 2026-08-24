#!/bin/sh
set -e

echo "[Roomly] Running database migrations..."
npx prisma migrate deploy

echo "[Roomly] Starting Next.js server..."
exec node server.js
