import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

/**
 * The whole Railway project, as code. `railway config plan` shows the drift between this
 * file and the live project; `railway config apply` makes the project match it.
 *
 * One service, one volume. Secrets are `preserve()`d: they live in Railway, not here.
 * AUTH_BASE_URL is preserved too, because it is the Google return address and the base of
 * every invite link: it has to be the address people actually open, which is decided in
 * DNS rather than in this file.
 */
export default defineRailway(() => {
  const data = volume("traveler-volume", {
    // Europe: the users, SL's APIs and the Valhalla server are all here.
    region: "europe-west4-drams3a",
    sizeMB: 50000,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

  const traveler = service("traveler", {
    source: github("kristofferremback/traveler", { branch: "master", checkSuites: false }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      // Liveness, not readiness: the first boot syncs SL's catalog for ~20 s and a deploy
      // must not fail because the catalog is still downloading. /api/ready is for callers.
      healthcheckPath: "/api/health",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    replicas: { "europe-west4-drams3a": 1 },
    env: {
      NODE_ENV: "production",
      DATABASE_PATH: "/data/traveler.db",
      AUTH_SECRET: preserve(),
      AUTH_BASE_URL: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
    TRAFIKLAB_GTFS_RT_KEY: preserve(),
    TRAFIKLAB_GTFS_STATIC_KEY: preserve(),
    },
    volumeMounts: {
      "/data": data,
    },
  });

  return project("traveler", {
    resources: [traveler, data],
  });
});
