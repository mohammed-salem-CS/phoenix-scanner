FROM node:18-alpine

WORKDIR /app

# Copy backend dependencies
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm install

# Copy backend source
COPY backend/ .

# Copy frontend (served by backend or separate, for now we assume backend serves/accessed directly or via volumes)
# Since the current setup has frontend as static files, we might need to serve them via Express or Nginx.
# For simplicity in this dev setup, we'll keep them separate or assume the user runs them locally.
# However, to make it a self-contained scanning engine:

EXPOSE 3000

CMD ["node", "server.js"]
