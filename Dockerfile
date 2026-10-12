# Official Microsoft Playwright image with all Linux system dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Set environment variables for Railway headless container execution
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HEADLESS=true
ENV PORT=8080

# Copy project files
COPY . .

# Install dependencies across all workspaces
RUN npm install

# Expose default port
EXPOSE 8080

# Start autonomous queue daemon
CMD ["node", "index.js"]

