FROM node:24-bookworm-slim AS build
LABEL io.klan.backend.build-stage=true
WORKDIR /app
COPY Project/package.json Project/package-lock.json ./
ARG CI_COMPILED=0
RUN if [ "$CI_COMPILED" = 1 ]; then npm ci --omit=dev --no-audit --no-fund; else npm ci; fi
COPY Project/tsconfig.json ./
COPY Project/src ./src
RUN if [ "$CI_COMPILED" = 1 ]; then mv src/.ci-dist dist; else npm run build && npm prune --omit=dev; fi

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node Project/data/location-catalog ./data/location-catalog
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
