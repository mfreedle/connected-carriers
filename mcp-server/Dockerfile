FROM node:20-alpine

WORKDIR /app

# Copy package file and install ALL dependencies (including dev for TypeScript build)
COPY package.json ./
RUN npm install

# Copy source and build TypeScript
COPY . .
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
