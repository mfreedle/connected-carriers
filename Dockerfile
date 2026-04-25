FROM nginx:alpine

# Install envsubst (part of gettext)
RUN apk add --no-cache gettext

# Copy site files
COPY . /usr/share/nginx/html

# Copy nginx template config
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Railway sets PORT env var — nginx official image runs envsubst on templates automatically
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
