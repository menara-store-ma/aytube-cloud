FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3400
EXPOSE 3400
CMD ["node", "web-app/server.mjs"]
