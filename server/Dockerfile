# 安卓远程协助 · 中继服务器生产镜像
# 构建：docker build -t remote-assist-relay:latest ./server
# 运行：docker run --rm -p 3000:3000 -e JWT_SECRET=... -e ADMIN_API_KEY=... remote-assist-relay:latest

# ---------- 构建阶段：需要 devDependencies 里的 typescript ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段：只保留生产依赖与编译产物 ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    TRUST_PROXY=false \
    TRUST_PROXY_HOPS=1 \
    LOG_LEVEL=info
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# 设备凭据摘要持久化到 /app/data（compose 中以命名卷挂载）；
# 预先建好目录并交给 node 用户，命名卷首次挂载时会继承该目录的属主。
RUN mkdir -p /app/data && chown node:node /app/data

# 非 root 运行
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
