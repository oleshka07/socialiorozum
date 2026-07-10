# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg + шрифт із кирилицею - збірка відео-рілсів (укр. субтитри через libass/DejaVu Sans)
RUN apk add --no-cache ffmpeg font-dejavu
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY db ./db
COPY public ./public
EXPOSE 8080
CMD ["npm", "run", "start"]
