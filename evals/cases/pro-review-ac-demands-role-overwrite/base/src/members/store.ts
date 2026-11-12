export type Role = 'member' | 'coach' | 'admin'
export type Member = { email: string; name: string; phone: string; role: Role }

const members = new Map<string, Member>()

export function findByEmail(email: string): Member | undefined {
  return members.get(email.trim().toLowerCase())
}

export function saveMember(member: Member): void {
  members.set(member.email.trim().toLowerCase(), member)
}
