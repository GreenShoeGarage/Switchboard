FROM node:22-bookworm-slim AS build
WORKDIR /opt/switchboard

ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /opt/switchboard

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    SWITCHBOARD_DATABASE_PATH=/data/switchboard.db \
    SWITCHBOARD_MIGRATIONS_PATH=/opt/switchboard/drizzle

RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /opt/switchboard /opt/switchboard

USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
