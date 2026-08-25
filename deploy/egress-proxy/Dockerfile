FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
RUN mkdir -p /var/log/ato && chown -R node:node /var/log/ato
USER node
EXPOSE 3128
CMD ["node", "server.mjs"]
