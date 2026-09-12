# 🤖 Сайдкар Claude Code CLI: «руки» підписки замість оплати за токени API.
#
# Чому ОКРЕМИЙ контейнер, а не CLI в образі застосунку і не docker exec у чужий:
#  • node:20-slim = glibc. Наш app-образ на alpine (musl), а @anthropic-ai/claude-code
#    розрахований на glibc - ставити його туди означає ловити musl-граблі на кожному апдейті.
#  • Токен підписки живе ЛИШЕ тут. У застосунку його немає, тож витік у застосунку
#    (а він обробляє дані чужих людей) не віддає чужу підписку.
#  • Альтернатива «змонтувати /var/run/docker.sock і робити docker exec» - це видача root
#    на хості веб-застосунку, відкритому в інтернет. Ні.
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Своя домівка (claude пише туди конфіг) і ПОРОЖНІЙ робочий каталог: якби cwd містив CLAUDE.md
# чи .claude/, CLI підтягнув би їх як контекст проєкту - і в пости поїхали б інструкції репозиторію.
RUN useradd -m -d /home/app app && mkdir -p /home/app/work && chown -R app:app /home/app
WORKDIR /app
COPY run.mjs ./
USER app
ENV HOME=/home/app
EXPOSE 8090
CMD ["node", "/app/run.mjs"]
