# StampTrace — static build served by nginx.
#   docker build -t stamptrace .  &&  docker run --rm -p 8080:80 stamptrace  → http://localhost:8080
FROM node:22-alpine AS build
WORKDIR /app
ARG GIT_COMMIT=docker
ENV GIT_COMMIT=$GIT_COMMIT
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# prebuild generates public/demo.mcap (synthetic recording) before the Vite build
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# .mcap served as binary
RUN printf 'types { application/octet-stream mcap; }\n' > /etc/nginx/conf.d/mcap.types \
 && sed -i 's|include       /etc/nginx/mime.types;|include       /etc/nginx/mime.types;\n    include /etc/nginx/conf.d/mcap.types;|' /etc/nginx/nginx.conf
EXPOSE 80
