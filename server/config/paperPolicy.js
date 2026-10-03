function paperOnly(env = process.env) {
  const value = String(env.PAPER_ONLY ?? "")
    .trim()
    .toLowerCase();
  if (!["", "true", "false"].includes(value))
    throw new Error("PAPER_ONLY must be true or false");
  return value === "true";
}
function assertPaperConfiguration(env = process.env) {
  if (paperOnly(env) && env.PRIVATE_KEY)
    throw new Error(
      "PAPER_ONLY refuses startup with PRIVATE_KEY present; remove it"
    );
}
function assertLiveAllowed(profile, env = process.env) {
  if (profile?.paperOnly || paperOnly(env)) {
    const error = new Error(
      "PAPER_ONLY: live signing is disabled by deployment configuration"
    );
    error.code = "PAPER_ONLY";
    throw error;
  }
}
module.exports = { paperOnly, assertPaperConfiguration, assertLiveAllowed };
