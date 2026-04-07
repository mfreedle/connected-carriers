FROM node:20-alpine

WORKDIR /app

# Copy package files and install ALL dependencies (including dev for build)
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY . .
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
