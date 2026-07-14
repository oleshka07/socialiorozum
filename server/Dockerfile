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
# chromium - Motion-рендер рілсів (Remotion: React-композиція → headless Chromium)
# util-linux-misc - справжній setpriv: Remotion запускає браузер через `setpriv --pdeathsig`,
# а BusyBox-заглушка з альпіни цю опцію не знає (browser launch падав з exit 1)
RUN apk add --no-cache ffmpeg font-dejavu chromium util-linux-misc
ENV REMOTION_CHROME=/usr/bin/chromium-browser
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY db ./db
COPY public ./public
COPY remotion ./remotion
EXPOSE 8080
CMD ["npm", "run", "start"]
