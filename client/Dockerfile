FROM node:20-alpine

WORKDIR /app

COPY client/package*.json ./
RUN npm ci

COPY client .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]


