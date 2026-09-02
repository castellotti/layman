docker stop layman && \
docker rm layman && \
docker compose build && \
docker compose up -d && \
docker logs -f layman
