FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# 의존성 먼저 (레이어 캐시)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 소스 복사
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "src/server.js"]
