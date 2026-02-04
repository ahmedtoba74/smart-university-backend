FROM node:22-alpine


WORKDIR /usr/src/app


COPY package*.json ./
RUN npm install


COPY . .


ENV NODE_ENV=development
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]