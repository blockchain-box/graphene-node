FROM nginx:alpine

# Remove default config and add our SPA config
RUN rm /etc/nginx/conf.d/default.conf
COPY docker/explorer/nginx.conf /etc/nginx/conf.d/default.conf

# Copy build output
COPY docker/explorer/app /usr/share/nginx/html

# Expose http
EXPOSE 8080

# Start nginx in foreground
CMD ["nginx", "-g", "daemon off;"]
