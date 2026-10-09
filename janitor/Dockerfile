FROM node:22.23.3-alpine
WORKDIR /app
COPY src ./src
ENV NODE_ENV=production
USER node
CMD ["node", "src/index.js"]
