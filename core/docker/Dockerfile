FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── 1. System packages ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Init + process management
    dumb-init \
    supervisor \
    # Virtual display + VNC stack
    xvfb \
    x11vnc \
    x11-utils \
    tigervnc-tools \
    # Lightweight window manager
    fluxbox \
    # Networking + utilities
    curl \
    wget \
    gnupg \
    ca-certificates \
    netcat \
    net-tools \
    procps \
    git \
    unzip \
    # Fonts (CJK coverage for international sites)
    fonts-liberation \
    fonts-noto-cjk \
    # Chrome runtime dependencies
    libgtk-3-0 \
    libxss1 \
    libnss3 \
    libnspr4 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
  && rm -rf /var/lib/apt/lists/*

# ── 2. Google Chrome stable ───────────────────────────────────────────────────
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
     | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
  && chmod a+r /etc/apt/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] \
     https://dl.google.com/linux/chrome/deb/ stable main" \
     > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# ── 3. noVNC + websockify ─────────────────────────────────────────────────────
RUN git clone --depth=1 https://github.com/novnc/noVNC.git /opt/novnc \
 && git clone --depth=1 https://github.com/novnc/websockify /opt/novnc/utils/websockify \
 && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# ── 4. App files ──────────────────────────────────────────────────────────────
RUN mkdir -p /root/chrome-data
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5901 8080

# dumb-init is PID 1: forwards signals correctly and reaps zombie processes.
# entrypoint.sh parses RESOLUTION → WIDTH/HEIGHT, then execs supervisord.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/entrypoint.sh"]
