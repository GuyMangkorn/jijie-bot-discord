const REQUIRED_CONFIG = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];

export function validateGeminiModel(model) {
  if (typeof model !== 'string' || !/^gemini-[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) {
    throw Object.assign(new Error('invalid_model'), { category: 'invalid_model' });
  }
  return model;
}

export function readConfig(env = process.env) {
  const config = {};
  const missing = [];

  for (const name of REQUIRED_CONFIG) {
    const value = env[name]?.trim();
    if (!value) {
      missing.push(name);
    } else {
      config[name] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(`กรุณากำหนดค่าในไฟล์ .env: ${missing.join(', ')}`);
  }

  return {
    token: config.DISCORD_TOKEN,
    clientId: config.DISCORD_CLIENT_ID,
    guildId: config.DISCORD_GUILD_ID,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: validateGeminiModel(env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash'),
  };
}
