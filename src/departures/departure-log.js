import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { escapeMarkdown } from 'discord.js';

export async function openDepartureLog(path, guildId) {
  let records = [];
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.version !== 1 || data.guildId !== guildId || !Array.isArray(data.records) ||
        data.records.length > 10 || data.records.some((record) =>
          typeof record.userId !== 'string' || typeof record.name !== 'string' ||
          !Number.isSafeInteger(record.leftAt) || record.leftAt <= 0)) {
      throw new Error('Invalid departure log');
    }
    records = data.records;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let pending = Promise.resolve();
  let writeError;
  return {
    record(member, leftAt = Date.now()) {
      if (member.guild.id !== guildId || member.user.bot) return Promise.resolve();
      const record = {
        userId: member.id,
        name: member.displayName || member.user.globalName || member.user.username || member.id,
        leftAt,
      };
      const operation = pending.then(async () => {
        records = [record, ...records].slice(0, 10);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, guildId, records }, null, 2), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        writeError = undefined;
      });
      pending = operation.catch((error) => { writeError = error; });
      return operation;
    },
    async latest() {
      await pending;
      if (writeError) throw writeError;
      return records.map((record) => ({ ...record }));
    },
  };
}

export function buildDeparturesEmbed(records) {
  return {
    title: 'สมาชิกที่ออกล่าสุด',
    description: records.length
      ? records.map((record, index) => {
          const name = escapeMarkdown(record.name.replace(/[\r\n\t]/g, ' ').slice(0, 100))
            .replaceAll('@', '@\u200b').replaceAll('<', '‹').replaceAll('>', '›');
          return `${index + 1}. ${name} (ID: ${record.userId}) — <t:${Math.floor(record.leftAt / 1000)}:f>`;
        }).join('\n')
      : 'ยังไม่มีประวัติสมาชิกที่ออกขณะบอตออนไลน์',
    footer: { text: 'เฉพาะที่บอตบันทึกได้ขณะออนไลน์ • รวมออกเอง/ถูกเตะ/ถูกแบน • ไม่นับบอต' },
  };
}
