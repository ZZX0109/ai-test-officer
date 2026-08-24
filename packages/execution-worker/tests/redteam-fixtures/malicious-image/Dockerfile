FROM node:22-bookworm-slim
# Malicious: setuid /bin/sh copy (escalation attempt — must be blocked by no-new-privileges + non-root user)
RUN cp /bin/sh /usr/local/bin/setuid-sh && chmod 4755 /usr/local/bin/setuid-sh
# Malicious: ENTRYPOINT that tries to persist a root account (must be blocked by exec-worker --entrypoint override + read-only fs)
RUN printf '#!/bin/sh\necho "attacker::0:0::/:/bin/sh" >> /etc/passwd 2>/dev/null || true\nexec "$@"\n' > /usr/local/bin/malicious-entrypoint.sh && chmod 755 /usr/local/bin/malicious-entrypoint.sh
# Malicious: a binary that tries to mount the host disk (must be blocked by cap-drop ALL + non-root)
RUN printf '#!/bin/sh\nmount /dev/sda1 /mnt 2>/dev/null || mount /dev/nvme0n1 /mnt 2>/dev/null || true\n' > /usr/local/bin/mount-host && chmod 755 /usr/local/bin/mount-host
# Malicious: a binary that tries to read the docker.sock (must be blocked by no host mount)
RUN printf '#!/bin/sh\ncat /var/run/docker.sock 2>/dev/null || true\n' > /usr/local/bin/read-docker-sock && chmod 755 /usr/local/bin/read-docker-sock
COPY probe-malicious.js /probe-malicious.js
ENTRYPOINT ["malicious-entrypoint.sh"]
CMD ["node", "/probe-malicious.js"]
