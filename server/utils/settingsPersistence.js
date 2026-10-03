const fs = require("fs");
const path = require("path");
const { settingsSchema, settingsDefaults } = require("./settingsSchema");
const storedSettingsSchema = settingsSchema
  .extend({ _savedAt: require("zod").z.string().datetime().optional() })
  .strict();
function readSettings(file, logger = console) {
  try {
    const stored = storedSettingsSchema.parse(
      JSON.parse(fs.readFileSync(file, "utf8"))
    );
    const { _savedAt, ...settings } = stored;
    return settings;
  } catch (error) {
    if (error.code !== "ENOENT")
      logger.warn(
        "[Settings] Invalid persisted settings; using defaults and environment overrides."
      );
    return null;
  }
}
function writeSettings(file, settings, logger = console) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const stored = storedSettingsSchema.parse({
      ...settingsSchema.parse(settings),
      _savedAt: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(stored, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return true;
  } catch (_) {
    try {
      fs.unlinkSync(temporary);
    } catch (_) {
      /* No temporary file. */
    }
    logger.error("[Settings] Failed to persist settings.");
    return false;
  }
}
function initialSettings(stored, env = process.env, logger = console) {
  const candidate = {
    ...settingsDefaults,
    ...(stored || {}),
    botActive: env.BOT_AUTO_START === "true",
  };
  const names = {
    pollingInterval: "POLLING_INTERVAL",
    gasPriceCeiling: "GAS_PRICE_CEILING",
    slippageBips: "SLIPPAGE_BIPS",
    minBorrowAmount: "MIN_BORROW_AMOUNT",
    simulationInputAmount: "SIMULATION_INPUT_AMOUNT",
  };
  for (const [field, key] of Object.entries(names))
    if (env[key] !== undefined && env[key] !== "") candidate[field] = env[key];
  if (env.FLASHBOTS_DEFAULT !== undefined)
    candidate.flashbotsDefault = env.FLASHBOTS_DEFAULT;
  const result = settingsSchema.safeParse(candidate);
  if (result.success) return result.data;
  logger.warn(
    "[Settings] Invalid initial settings; using safe defaults without auto-start."
  );
  return settingsSchema.parse(settingsDefaults);
}
function productionOverrides(settings, stored, env = process.env) {
  const mapping = [
    ["gasPriceCeiling", "gasCeilingGwei", "GAS_PRICE_CEILING"],
    ["slippageBips", "slippageBps", "SLIPPAGE_BIPS"],
    ["minBorrowAmount", "minBorrowAmount", "MIN_BORROW_AMOUNT"],
    ["simulationInputAmount", "maxBorrowAmount", "SIMULATION_INPUT_AMOUNT"],
  ];
  const result = {};
  for (const [field, key, variable] of mapping)
    if (
      Object.hasOwn(stored || {}, field) ||
      (env[variable] !== undefined && env[variable] !== "")
    )
      result[key] =
        field === "slippageBips" ? settings[field] : String(settings[field]);
  return result;
}
module.exports = {
  readSettings,
  writeSettings,
  initialSettings,
  productionOverrides,
  storedSettingsSchema,
};
