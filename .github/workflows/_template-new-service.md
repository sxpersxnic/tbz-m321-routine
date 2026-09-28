# Adding the pipeline for a new service

Every Node service has its own caller workflow that runs the shared pipeline
[`_node-service.yml`](_node-service.yml) (lint → typecheck → tests → container image) only when
that service, the chassis, the contracts or the build setup change. This file is not a
workflow – GitHub only runs `*.yml` files here.

For a new service `<name>` (directory `services/<name>/`):

1. Create `.github/workflows/<name>.yml` with this content, replacing `<name>`:

   ```yaml
   name: <name>

   on:
     push:
       branches: [main]
       paths:
         - services/<name>/**
         - libs/**
         - contracts/**
         - docker/node-service.Dockerfile
         - package-lock.json
         - biome.json
         - tsconfig.json
         - .github/workflows/<name>.yml
         - .github/workflows/_node-service.yml
     pull_request:
       paths:
         - services/<name>/**
         - libs/**
         - contracts/**
         - docker/node-service.Dockerfile
         - package-lock.json
         - biome.json
         - tsconfig.json
         - .github/workflows/<name>.yml
         - .github/workflows/_node-service.yml
     workflow_dispatch:

   jobs:
     pipeline:
       uses: ./.github/workflows/_node-service.yml
       with:
         service: <name>
   ```

2. Add the service's `package.json` to the dependency stage of
   [`docker/node-service.Dockerfile`](../../docker/node-service.Dockerfile)
   (`COPY services/<name>/package.json services/<name>/`), or `npm ci` in the image won't know the
   workspace.

3. The service needs `services/<name>/tsconfig.json` (copy task-service's) – the pipeline
   typechecks with it – and a `test/` directory with at least contract tests
   ([docs/v2/10-quality.md §1](../../docs/v2/10-quality.md)).

The rest of a new service (database in `infra/postgres/domains-init.sql`, compose profile,
`deploy/stack.yml`, gateway route, service account, topology) is on the scaffolding checklist in
[docs/v2/10-quality.md §5](../../docs/v2/10-quality.md).
