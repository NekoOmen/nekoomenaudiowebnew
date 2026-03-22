FROM node:20-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Setup app
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# Koyeb uses PORT env variable
EXPOSE 3000

CMD ["node", "server.js"]
