export default {
  extends: ["ultracite/core"],
  overrides: [
    { extends: ["ultracite/react"], files: ["apps/web/**/*"] },
    { extends: ["ultracite/astro"], files: ["apps/docs/**/*"] },
  ],
};
