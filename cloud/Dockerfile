# BrewPhase Cloud — 生产容器
# 多阶段构建：依赖安装 → TS 编译 → 运行时镜像（非 root，只带生产依赖与编译产物）。
# 构建（在 cloud/ 目录下）：docker build -t brewphase-cloud .

FROM node:22-alpine AS base
# corepack 按 package.json 的 packageManager 字段启用本地锁文件同版本 pnpm
RUN corepack enable
WORKDIR /app

# ---- 依赖层（利用 Docker 层缓存，lockfile 不变则不重装）----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- 构建层：编译 TS + 复制迁移文件 ----
FROM deps AS build
COPY . .
RUN pnpm build

# ---- 运行时 ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# 非 root 运行
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 数据库迁移通过显式命令执行：node dist/scripts/migrate.js（见 README）
CMD ["node", "dist/index.js"]
