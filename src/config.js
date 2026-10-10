const REQUIRED_CONFIG = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];

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
  };
}
