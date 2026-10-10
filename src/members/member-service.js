import { selectLatestMembers } from './latest-members.js';

export async function fetchLatestMembers(guild) {
  const members = await guild.members.fetch();
  return selectLatestMembers(members.values()).map((member) => ({
    userId: member.id,
    name: member.displayName || member.user.globalName || member.user.username || member.id,
    joinedAt: member.joinedTimestamp,
  }));
}
