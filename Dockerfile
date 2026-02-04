FROM node:22-alpine

# تحديد مكان الكود
WORKDIR /usr/src/app

# نسخ ملفات التعريف وتثبيت المكتبات
COPY package*.json ./
RUN npm install

# نسخ الكود
COPY . .

# مهم جداً عشان الـ app.js بتاعك ميعملش Fatal Error
ENV NODE_ENV=development
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]