export function selectLatestMembers(members) {
  return [...members]
    .filter(
      (member) =>
        !member.user.bot &&
        typeof member.joinedTimestamp === 'number' &&
        Number.isFinite(member.joinedTimestamp),
    )
    .sort((a, b) => {
      const byJoinTime = b.joinedTimestamp - a.joinedTimestamp;
      if (byJoinTime !== 0) return byJoinTime;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    })
    .slice(0, 10);
}

export function buildMembersEmbed(members) {
  const description = members.length
    ? members
        .map(
          (member, index) =>
            `${index + 1}. <@${member.id}> — <t:${Math.floor(member.joinedTimestamp / 1000)}:f>`,
        )
        .join('\n')
    : 'ไม่พบสมาชิกที่มีข้อมูลเวลาเข้าร่วม';

  return {
    title: 'สมาชิกที่เข้าร่วมล่าสุด',
    description,
  };
}
