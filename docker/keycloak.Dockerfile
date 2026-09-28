# syntax=docker/dockerfile:1
# Identity provider: Keycloak with the build-time options baked in (fast `--optimized` start) and the
# realm "routine" as code. Runtime settings (hostname, database, admin) come from the environment.

FROM quay.io/keycloak/keycloak:26.7 AS build
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=/auth
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7
COPY --from=build /opt/keycloak/ /opt/keycloak/
# imported on start when the realm does not exist yet – an existing realm is never overwritten
COPY infra/keycloak/realm-routine.json /opt/keycloak/data/import/realm-routine.json
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
