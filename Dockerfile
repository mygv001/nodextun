FROM node:20-alpine3.20

WORKDIR /data

COPY index.js index.html package.json ./

EXPOSE 8405

RUN apk update && apk add --no-cache bash openssl curl &&\
    chmod +x index.js &&\
    npm install

CMD ["node", "index.js"]
