FROM node:20-alpine

WORKDIR /app

# Build context is repo root — reference mcp-server/ paths explicitly
COPY mcp-server/package.json ./
RUN npm install

# Copy mcp-server source files
COPY mcp-server/ ./

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
