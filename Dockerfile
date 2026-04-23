# Official Playwright image – all Chromium system deps included
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package*.json ./
# Skip postinstall – browsers already exist in the base image
RUN npm install --ignore-scripts

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
