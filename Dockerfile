# Use official Node 18 slim image
FROM node:18-slim

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY . .

# Expose port (must match server PORT)
EXPOSE 4000

# Start the server
CMD ["node", "server.js"]
