interface GroupProfile {
  group_name: string;
  group_icon: string;
}

interface CacheEntry {
  profile: GroupProfile;
  expiresAt: number;
  pending?: Promise<GroupProfile>;
}

const CACHE_TTL = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const QUERY_TIMEOUT = 2000;
const MAX_ENTRIES = 1000;

export class GroupProfileCache {
  private entries = new Map<string, CacheEntry>();

  public clear(): void {
    this.entries.clear();
  }

  public async get(groupId: string, loadName: () => Promise<string>): Promise<GroupProfile> {
    let entry = this.entries.get(groupId);
    if (entry?.pending) return entry.pending;
    if (entry && entry.expiresAt > Date.now()) return entry.profile;

    if (!entry) {
      const profile = {
        group_name: '',
        group_icon: `https://p.qlogo.cn/gh/${groupId}/${groupId}/100`,
      };
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = [...this.entries].find(([, value]) => !value.pending);
        if (!oldest) return profile;
        this.entries.delete(oldest[0]);
      }
      entry = { profile, expiresAt: 0 };
      this.entries.set(groupId, entry);
    }

    entry.pending = this.refresh(entry, loadName);
    return entry.pending;
  }

  private async refresh(entry: CacheEntry, loadName: () => Promise<string>): Promise<GroupProfile> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const name = await Promise.race([
        Promise.resolve().then(loadName),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('群资料查询超时')), QUERY_TIMEOUT);
        }),
      ]);
      const groupName = typeof name === 'string' ? name.trim() : '';
      if (groupName) {
        entry.profile = { ...entry.profile, group_name: groupName };
      }
      entry.expiresAt = Date.now() + (groupName ? CACHE_TTL : RETRY_DELAY);
    } catch {
      entry.expiresAt = Date.now() + RETRY_DELAY;
    } finally {
      clearTimeout(timer);
      entry.pending = undefined;
    }
    return entry.profile;
  }
}
