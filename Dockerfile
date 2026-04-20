FROM mcr.microsoft.com/playwright:v1.58.0-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Create output directory for reports
RUN mkdir -p output

# Railway sets PORT automatically; default to 3000
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]