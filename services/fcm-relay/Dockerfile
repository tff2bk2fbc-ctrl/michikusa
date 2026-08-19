FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server.mjs ./
ENV NODE_ENV=production
ENV PORT=8080
USER node
CMD ["node", "server.mjs"]
