FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY server/package*.json ./
RUN npm ci

# Copy source
COPY server .

# Build TypeScript
# For dev we run the ts watcher; build step is optional
RUN npm run build || true

# Entrypoint to ensure deps are installed when bind-mount hides image node_modules
COPY server/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]


