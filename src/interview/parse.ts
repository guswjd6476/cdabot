// 당일 인터뷰 결과지 (순수 함수). '▪️후속연결O/보류/X' 구간 아래 '#이름/지역/인도자/인터뷰자/메모' 줄을 사람별로 정리
//   칸 수가 사람마다 달라서 이름·후속 상태·연락처·생년월일만 확실히 뽑고 나머지는 메모 원문으로 둠

export type FollowUp = 'O' | '보류' | 'X';
export const FOLLOW_UPS: FollowUp[] = ['O', '보류', 'X'];

export interface InterviewEntry {
    name: string;
    followUp: FollowUp | null; // 구간 제목 전에 나온 줄은 null
    region: string | null;
    guides: string[]; // 인도자 (여러 명 가능)
    interviewer: string | null;
    phone: string | null;
    birthDate: string | null;
    memo: string;
}

const EMPTY = /^[-–—]$/;
// 사람 이름 칸: '홍길동' 또는 '양이슬, 김준수' 또는 '-'
const PEOPLE = /^([가-힣]{2,4}(\s*,\s*[가-힣]{2,4})*|[-–—])$/;
// shortcut: 지역은 '-' 이거나 사람 이름(3~4자) 모양이 아니면 지역으로 봄 — 3글자 지역명이 생기면 지역 목록으로 판별
const NAME_ONLY = /^[가-힣]{3,4}(\s*,\s*[가-힣]{2,4})*$/;

function followUpOf(line: string): FollowUp | undefined {
    if (!/후속\s*연결/.test(line)) return undefined;
    if (/보류/.test(line)) return '보류';
    if (/후속\s*연결\s*[Xx×✕✖]/.test(line)) return 'X';
    if (/후속\s*연결\s*[Oo○⭕0]/.test(line)) return 'O';
    return undefined;
}

const PHONE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/;
export function findPhone(text: string): string | null {
    const m = text.match(PHONE);
    if (!m) return null;
    const d = m[0].replace(/\D/g, '');
    return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}
export const findBirth = (text: string) => text.match(/생년월일\s*[:：]?\s*(\d{6}(?:\d{2})?)(?!\d)/)?.[1] ?? null;

export function parseInterviewSheet(raw: string): InterviewEntry[] {
    const out: InterviewEntry[] = [];
    let followUp: FollowUp | null = null;
    let cur: { head: string; more: string[]; followUp: FollowUp | null } | null = null;
    const flush = () => {
        if (cur) out.push(toEntry(cur.head, cur.more, cur.followUp));
        cur = null;
    };
    for (const line of raw.normalize('NFKC').split('\n')) {
        const t = line.trim();
        const f = followUpOf(t);
        if (f) {
            flush();
            followUp = f;
        } else if (/^#[가-힣A-Za-z0-9]/.test(t) && t.includes('/')) {
            flush();
            cur = { head: t.slice(1), more: [], followUp };
        } else if (/^▪|^✔|^📌/.test(t)) {
            flush(); // 다른 제목 줄 → 앞 사람 메모 끝
        } else if (cur && t) {
            cur.more.push(t);
        }
    }
    flush();
    return out;
}

function toEntry(head: string, more: string[], followUp: FollowUp | null): InterviewEntry {
    const parts = head.split('/').map((x) => x.trim());
    const name = parts[0].slice(0, 30);
    let i = 1;
    let region: string | null = null;
    if (parts.length > 1 && !NAME_ONLY.test(parts[1])) {
        region = EMPTY.test(parts[1]) ? null : parts[1].slice(0, 30);
        i = 2;
    }
    // 이어지는 사람 이름 칸 최대 2개: [인도자, 인터뷰자]. 하나뿐이면 인터뷰자로 봄
    const people: string[] = [];
    while (people.length < 2 && i < parts.length && PEOPLE.test(parts[i])) people.push(parts[i++]);
    const names = (s?: string) => (s && !EMPTY.test(s) ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
    const guides = people.length === 2 ? names(people[0]) : [];
    const interviewer = names(people[people.length - 1])[0] ?? null;
    const memo = [parts.slice(i).join('/'), ...more].filter(Boolean).join('\n').slice(0, 2000);
    const all = [head, ...more].join('\n');
    return { name, followUp, region, guides, interviewer, phone: findPhone(all), birthDate: findBirth(all), memo };
}
