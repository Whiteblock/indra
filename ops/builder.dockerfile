FROM node:10-alpine
WORKDIR /root
ENV HOME /root
RUN apk add --update --no-cache bash curl g++ gcc git jq make python
RUN yarn global add yarn@1.13
COPY ops /ops
ENTRYPOINT ["bash", "/ops/permissions-fixer.sh"]
