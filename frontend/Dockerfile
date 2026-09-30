# Frontend image for Kubernetes (Vercel builds from source and ignores this).
#   docker build -t doppelganger-frontend frontend/
# BACKEND_URL / BACKEND_API_KEY are read at runtime by the server-side proxy routes.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app /app/.next/standalone ./
COPY --from=build --chown=app /app/.next/static .next/static
COPY --from=build --chown=app /app/public public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
