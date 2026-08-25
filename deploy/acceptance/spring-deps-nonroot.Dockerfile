FROM spring-deps:latest

# The base acceptance image was assembled with Maven's cache under /root/.m2.
# Agent sandboxes run as uid 65532, so copy the immutable repository to a
# world-readable path and make Maven use it without requiring root access.
RUN mkdir -p /opt/maven-cache \
  && cp -a /root/.m2/. /opt/maven-cache/ \
  && chmod -R a+rX /opt/maven-cache

ENV MAVEN_CONFIG=/opt/maven-cache \
    MAVEN_OPTS=-Dmaven.repo.local=/opt/maven-cache
