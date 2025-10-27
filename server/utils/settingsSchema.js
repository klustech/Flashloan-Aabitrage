const { z } = require("zod");

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

const settingsSchema = z
  .object({
    botActive: z.boolean(),
    ...SETTINGS_FIELD_SCHEMAS,
  })
  .strict();

const settingsUpdateSchema = z
  .object({
    flashbotsDefault: SETTINGS_FIELD_SCHEMAS.flashbotsDefault.optional(),
    pollingInterval: SETTINGS_FIELD_SCHEMAS.pollingInterval.optional(),
    gasPriceCeiling: SETTINGS_FIELD_SCHEMAS.gasPriceCeiling.optional(),
    slippageBips: SETTINGS_FIELD_SCHEMAS.slippageBips.optional(),
    minBorrowAmount: SETTINGS_FIELD_SCHEMAS.minBorrowAmount.optional(),
    simulationInputAmount:
      SETTINGS_FIELD_SCHEMAS.simulationInputAmount.optional(),
  })
  .strict();

const settingsDefaults = {
  botActive: true,
  flashbotsDefault: false,
  pollingInterval: 60,
  gasPriceCeiling: 50,
  slippageBips: 50,
  minBorrowAmount: 100,
  simulationInputAmount: 1_000_000,
};

const formatValidationErrors = (error) => {
  const { fieldErrors, formErrors } = error.flatten();
  const cleanedFieldErrors = Object.fromEntries(
    Object.entries(fieldErrors).map(([key, messages]) => [
      key,
      messages.filter(Boolean),
    ])
  );

  return {
    fieldErrors: cleanedFieldErrors,
    formErrors: formErrors.filter(Boolean),
  };
};

module.exports = {
  settingsSchema,
  settingsUpdateSchema,
  settingsDefaults,
  formatValidationErrors,
};
