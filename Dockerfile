FROM nginx:alpine

# Install envsubst (part of gettext)
RUN apk add --no-cache gettext

# Copy nginx config first (ensures it's always present)
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Copy site files
COPY *.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

# Railway sets PORT env var — nginx official image runs envsubst on templates automatically
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
