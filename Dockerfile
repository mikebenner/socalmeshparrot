FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install
RUN npm install -g tsx

COPY . .

# Remove existing 'src/protobufs' if it exists, then clone the repository
RUN rm -rf src/protobufs && git clone https://github.com/meshtastic/protobufs.git src/protobufs

CMD [ "tsx", "index.ts" ]
