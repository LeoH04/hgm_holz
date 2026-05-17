FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY index.html style.css script.js ./
COPY admin.html admin-login.html admin.css admin.js ./
COPY assets ./assets

RUN mkdir -p data && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "server.js"]
