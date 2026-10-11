# The computer each chat gets. The donor image ships the helper that @cloudflare/sandbox runs in the container;
# keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM debian:trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl git jq python3 python3-pip unzip zip \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace/.agents/skills
WORKDIR /workspace
CMD ["sleep", "infinity"]
