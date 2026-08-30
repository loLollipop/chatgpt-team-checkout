FROM node:22-alpine

WORKDIR /app

RUN npm init -y \
  && npm install --omit=dev undici@6.28.0 \
  && npm cache clean --force

COPY --chown=node:node server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=8790

USER node

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
