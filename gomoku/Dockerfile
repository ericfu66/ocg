# ---------- 第一阶段：编译 Rapfi 引擎（构建时联网拉取最新源码与权重）
FROM debian:trixie-slim AS engine
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates cmake make clang \
    && rm -rf /var/lib/apt/lists/*
ARG CPU_TARGET=avx2
ARG RAPFI_REPO=https://github.com/dhbloo/rapfi
ARG RAPFI_REF=master
ARG NETWORKS_REPO=https://github.com/dhbloo/rapfi-networks
ARG NETWORKS_REF=main
# 修改 CACHE_BUST 的值即可强制重新拉取最新代码：--build-arg CACHE_BUST=$(date +%s)
ARG CACHE_BUST=1
COPY scripts/build-engine.sh /build-engine.sh
RUN chmod +x /build-engine.sh && \
    CPU_TARGET=$CPU_TARGET RAPFI_REPO=$RAPFI_REPO RAPFI_REF=$RAPFI_REF \
    NETWORKS_REPO=$NETWORKS_REPO NETWORKS_REF=$NETWORKS_REF WORK_DIR=/src \
    /build-engine.sh /engine

# ---------- 第二阶段：运行环境
FROM node:22-trixie-slim
ENV NODE_ENV=production PORT=8080 ENGINE_DIR=/app/engine
# Rapfi 运行时依赖 libatomic
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/ ./
COPY public/ /app/public/
COPY --from=engine /engine /app/engine
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
