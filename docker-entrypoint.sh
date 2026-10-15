#!/bin/sh
set -e

echo "🔄 Running database migrations..."

# Wait for PostgreSQL to be ready
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" 2>/dev/null; do
  echo "⏳ Waiting for PostgreSQL to be ready..."
  sleep 2
done

echo "✅ PostgreSQL is ready"

# Run database migrations using drizzle-kit push
echo "🔄 Pushing database schema..."
npm run db:push

echo "✅ Database schema is up to date"

# Start the application
echo "🚀 Starting application..."
exec npm start
