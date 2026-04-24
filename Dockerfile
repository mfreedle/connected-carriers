FROM nginx:alpine

# Cache bust
ARG CACHEBUST=2

RUN apk add --no-cache gettext

# Copy nginx config
COPY nginx-site.conf /etc/nginx/templates/default.conf.template

# Copy site files
COPY index.html about.html pricing.html contact.html terms.html privacy.html dispatch.html post-load.html waitlist.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
