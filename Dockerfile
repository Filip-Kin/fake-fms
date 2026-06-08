# syntax=docker/dockerfile:1
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
RUN bun install --frozen-lockfile
COPY . .
RUN cd packages/ui && bun run build

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app
# Bind to port 80 inside the container (needs root).
USER root
WORKDIR /app/packages/server
ENV FMS_PORT=80
ENV CONTROL_PORT=3010
EXPOSE 80 3010
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://localhost:80/FieldMonitor').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
