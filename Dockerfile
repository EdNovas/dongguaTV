# 多架构支持: linux/amd64, linux/arm64, linux/arm/v7
# Node 22 LTS(维护到 2027-04-30):官方 node:24/26-alpine 已不发 arm/v7,22 是唯一还覆盖三架构的补丁版。
# 18/20 已 EOL,不再有安全修复(如 CVE-2026-111497 Brotli 解码越界写),别退回。
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

# 安装构建依赖 (better-sqlite3 没有匹配的预编译包时需要原生编译)
# 注意: ARM 架构会自动使用对应的编译工具链
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    make \
    g++ \
    && npm install --omit=dev \
    && apk del .build-deps

COPY . .

# 创建必要的目录
RUN mkdir -p /app/public/cache/images

EXPOSE 3000

CMD ["node", "server.js"]
