# Use Node.js 20 - same version as Replit
FROM node:20-alpine

# Install necessary build tools for native dependencies and PostgreSQL client for health checks
RUN apk add --no-cache python3 make g++ postgresql-client

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for drizzle-kit)
RUN npm ci

# Copy application code
COPY . .

# Build the application
RUN npm run build

# Copy and set permissions for entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Set environment to production
ENV NODE_ENV=production

# Default app port (set APP_PORT in .env to change it; Synology uses 5000 for DSM)
EXPOSE 3001

# Use entrypoint script to run migrations and start the app
ENTRYPOINT ["/docker-entrypoint.sh"]
