FROM node:22.23.3-alpine
WORKDIR /app
COPY src ./src
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8090
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
