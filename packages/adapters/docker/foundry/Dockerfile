ARG BASE_IMAGE=oven/bun:1.4.4
FROM ${BASE_IMAGE}
ARG FOUNDRY_ARCH=arm64
USER 0:0
COPY child-${FOUNDRY_ARCH}.bpf /etc/foundry/child.bpf
# Refuse truncated COPY/build-context bytes before an image can be tagged.
RUN case "$FOUNDRY_ARCH" in \
      arm64) expected=7a54cb7e393fcc72637038232fdb1d1081af593e7f536881d4247b1c461c4104 ;; \
      x64) expected=36146a6a98806e0f76fd970cdee9fc3dae204c8dd282dd37c345df94e1ffae15 ;; \
      *) exit 64 ;; \
    esac && printf '%s  /etc/foundry/child.bpf\n' "$expected" | sha256sum -c - \
    && chmod 0444 /etc/foundry/child.bpf
LABEL org.agentes.foundry.runtime="pure-receipt-v1"
