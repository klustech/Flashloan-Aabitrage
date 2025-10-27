import { z } from "zod";

const createIntSchema = (min, max, label) => {
  let schema = z
    .coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .int({ message: `${label} must be an integer` })
    .min(min, { message: `${label} must be at least ${min}` });

  if (typeof max === "number") {
    schema = schema.max(max, { message: `${label} must be at most ${max}` });
  }

  return schema;
};

const coerceBoolean = (label) =>
  z.preprocess((val) => {
    if (typeof val === "string") {
      const normalized = val.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    return val;
  }, z.boolean({ invalid_type_error: `${label} must be a boolean` }));

const SETTINGS_FIELD_SCHEMAS = {
  flashbotsDefault: coerceBoolean("flashbotsDefault"),
  pollingInterval: createIntSchema(5, 3600, "pollingInterval"),
  gasPriceCeiling: createIntSchema(1, 1_000_000, "gasPriceCeiling"),
  slippageBips: createIntSchema(0, 10_000, "slippageBips"),
  minBorrowAmount: createIntSchema(1, undefined, "minBorrowAmount"),
  simulationInputAmount: createIntSchema(1, undefined, "simulationInputAmount"),
};

export const settingsUpdateSchema = z
  .object({
    flashbotsDefault: SETTINGS_FIELD_SCHEMAS.flashbotsDefault,
    pollingInterval: SETTINGS_FIELD_SCHEMAS.pollingInterval,
    gasPriceCeiling: SETTINGS_FIELD_SCHEMAS.gasPriceCeiling,
    slippageBips: SETTINGS_FIELD_SCHEMAS.slippageBips,
    minBorrowAmount: SETTINGS_FIELD_SCHEMAS.minBorrowAmount,
    simulationInputAmount: SETTINGS_FIELD_SCHEMAS.simulationInputAmount,
  })
  .strict();

export const settingsResponseSchema = settingsUpdateSchema.extend({
  botActive: z.boolean(),
});

export const settingsDefaults = {
  flashbotsDefault: false,
  pollingInterval: 60,
  gasPriceCeiling: 50,
  slippageBips: 50,
  minBorrowAmount: 100,
  simulationInputAmount: 1_000_000,
};

export const pickSettingsFields = (data = {}) => {
  const keys = Object.keys(SETTINGS_FIELD_SCHEMAS);
  return keys.reduce((acc, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      acc[key] = data[key];
    }
    return acc;
  }, {});
};

export const normalizeFieldErrors = (errors = {}) =>
  Object.fromEntries(
    Object.entries(errors).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.filter(Boolean).join(" ") : value,
    ])
  );
