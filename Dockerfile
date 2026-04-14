FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY voice-bridge.js mcp-auth-proxy.js start-production.sh ./
RUN chmod +x /app/start-production.sh && mkdir -p /data

EXPOSE 8080

CMD ["./start-production.sh"]
