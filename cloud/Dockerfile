# BrewPhase Cloud — 生产容器（Phase 1.3.3-A-R5）
#
# 四阶段：全量依赖 → 编译 → 生产依赖 → 运行时
#
# 为什么要单独一个 `prod-deps` 阶段：原来直接把 build 阶段的 `node_modules`
# 整个复制进运行镜像，那里面带着 typescript / eslint / vitest / drizzle-kit /
# @types —— 约 10 个 devDependencies。它们不被 `dist/` 引用（已核对 `src/`
# 无任何 devDep import），却把镜像体积、攻击面与 `npm audit` 噪声一起带上了生产。
#
# 构建（在 cloud/ 目录下）：docker build -t brewphase-cloud .
# 迁移（生产显式执行）：docker run --rm --env-file … brewphase-cloud node dist/scripts/migrate.js

FROM node:22-alpine AS base
# corepack 按 package.json 的 packageManager 字段启用本地锁文件同版本 pnpm
RUN corepack enable
WORKDIR /app

# ---- 全量依赖层（含 devDependencies：tsc 与 @types 是编译必需）----
# 独立成层是为了让 lockfile 不变时命中缓存，且**不污染**运行镜像。
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- 构建层：编译 TS + 把迁移 SQL 复制进 dist ----
FROM deps AS build
COPY . .
# `pnpm build` = `tsc -p tsconfig.build.json && node scripts/copy-assets.mjs`
# 后者保证 dist/db/migrations/ 与 src/db/migrations/ 同构（迁移入口靠它）。
RUN pnpm build

# ---- 生产依赖层：只装 dependencies ----
# 与 deps 层分开、重新安装而不是 `pnpm prune`：prune 会在同一棵 node_modules
# 上删包，层缓存与产物都更难推理；重装则产物只含 8 个运行时依赖。
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- 运行时 ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 只带编译产物与生产依赖：
#   dist/            —— 含 dist/index.js、dist/scripts/migrate.js、dist/db/migrations/
#   node_modules/    —— 来自 prod-deps（pnpm 的 .pnpm 虚拟存储随目录一起复制，
#                      顶层符号链接因此仍然有效）
#   package.json     —— pnpm 与 node 的模块解析需要
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# 构建期产物里不该有源码与配置：源码只在 build 层，.env 被 .dockerignore 排除。

# 非 root 运行（node:alpine 自带 `node` 用户）
USER node

EXPOSE 3000

# /health 只代表进程存活；数据库可用性看 /ready（由 smoke-test 校验）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 数据库迁移**不**在启动时自动执行：显式命令，失败即失败，
# 不会出现「服务起来了但 schema 是旧的」。
#   node dist/scripts/migrate.js
CMD ["node", "dist/index.js"]
