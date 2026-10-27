// 당일 인터뷰 결과지 (순수 함수). '▪️후속연결O/보류/X' 구간 아래 사람 줄을 정리
//   새 양식: 섭외자/성별/생년월일/연락처/인도자지역/인도자/인터뷰자/다음 만남예정일, 장소/간단정보 (둘째 칸이 성별이면 새 양식)
//   잠깐 쓴 양식(생년월일 칸 없음): 섭외자/성별/연락처/지역/인도자/인터뷰자/… — 셋째 칸이 연락처면 이것으로 읽음
//   예전 양식: 섭외자/지역/인도자/인터뷰자/다음 만남예정일, 장소/간단정보 (밀린 결과용으로 계속 읽음)
//   칸 수가 사람마다 달라서 이름·후속 상태·연락처·생년월일만 확실히 뽑고 나머지는 메모 원문으로 둠

export type FollowUp = 'O' | '보류' | 'X';
export const FOLLOW_UPS: FollowUp[] = ['O', '보류', 'X'];

export type InterviewKind = '향수행사' | '당터뷰';
export const KINDS: InterviewKind[] = ['향수행사', '당터뷰'];

// 구분: '구분: 향수행사' 줄이 있으면 그대로, 없으면 첫 '#' 줄 위(제목·안내)에 '당일 인터뷰'면 당터뷰, '향수'가 있으면 향수행사, 둘 다 없으면 당터뷰
// (향수 양식 안내문에도 '당터뷰'라는 말이 있어서 '향수' 여부로만 판단. 메모 속 단어는 보지 않음)
export function sheetKind(raw: string): InterviewKind {
    const text = raw.normalize('NFKC');
    const line = text.match(/^\s*(?:구분|종류)\s*[:：]?\s*(.+)$/m)?.[1];
    if (line) return /향수/.test(line) ? '향수행사' : '당터뷰';
    const head = text.split(/^\s*#/m)[0];
    if (/당일\s*인터뷰/.test(head)) return '당터뷰'; // '📌 당일 인터뷰 양식'
    return /향수/.test(head) ? '향수행사' : '당터뷰'; // '📌 향수 인터뷰 양식'
}

export interface InterviewEntry {
    name: string;
    followUp: FollowUp | null; // 구간 제목 전에 나온 줄은 null
    region: string | null;
    guides: string[]; // 인도자 (여러 명 가능)
    interviewer: string | null;
    gender: string | null; // 새 양식만 ('남'/'여')
    phone: string | null;
    birthDate: string | null;
    memo: string;
}

const EMPTY = /^[-–—]$/;
// 사람 이름 칸: '홍길동' 또는 '양이슬, 김준수' 또는 '-'
const PEOPLE = /^([가-힣]{2,4}(\s*,\s*[가-힣]{2,4})*|[-–—])$/;
const NAME_ONLY = /^[가-힣]{3,4}(\s*,\s*[가-힣]{2,4})*$/;
const NOT_NAME = /^(새신자|기신자|재신자)$/; // 지역 칸에 오는 구분 (이름 모양이지만 사람 아님)
// '#' 없이 쓴 사람 줄: 이름(함00 같은 표기 포함)으로 시작하고 '/' 2개 이상
const PLAIN_ENTRY = /^[가-힣]{1,4}[0-9○]{0,2}\s*\/[^/]*\//;

function followUpOf(line: string): FollowUp | undefined {
    if (!/후속\s*연결/.test(line)) return undefined;
    if (/보류/.test(line)) return '보류';
    // '후속연결O', '후속 연결: o', '후속연결 (O)', '후속연결 - ⭕', '후속연결 ✅' 모두
    const mark = line.match(/후속\s*연결\s*(?:여부)?\s*[:：\-–(\[]?\s*(\S)/)?.[1];
    if (mark && /[Xx×✕✖❌]/.test(mark)) return 'X';
    if (mark && /[Oo○⭕0✅]/.test(mark)) return 'O';
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
        } else if ((/^#[가-힣A-Za-z0-9]/.test(t) && t.includes('/')) || (followUp && PLAIN_ENTRY.test(t))) {
            // '#이름/…' 줄, 또는 후속연결 제목 아래의 '이름/…/…' 줄 (위쪽 양식 안내 '섭외자/지역/…'는 제목 전이라 제외)
            flush();
            cur = { head: t.replace(/^#/, ''), more: [], followUp };
        } else if (/^▪|^✔|^📌/.test(t)) {
            flush(); // 다른 제목 줄 → 앞 사람 메모 끝
        } else if (cur && t) {
            cur.more.push(t);
        }
    }
    flush();
    return out;
}

// 새 양식: 둘째 칸이 성별(남·여·남자·여성), 또는 성별이 빈 칸('-')이면서 셋째 칸이 연락처 숫자이거나 칸이 7개 이상 (예전 양식은 보통 6칸 이하)
const GENDER = /^(남|여)(자|성)?$/;
const blank = (x?: string) => !x || EMPTY.test(x);
const isPhone = (x?: string) => !!x && (/^01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}$/.test(x) || /^\d{4}$/.test(x)); // 전체 번호 또는 뒷자리 4자리
const isNewForm = (p: string[]) => GENDER.test(p[1] ?? '') || (blank(p[1]) && (/^[\d\s.\-]{4,}$/.test(p[2] ?? '') || p.length >= 7));

function toEntry(head: string, more: string[], followUp: FollowUp | null): InterviewEntry {
    const parts = head.split('/').map((x) => x.trim());
    const name = parts[0].slice(0, 30);
    const all = [head, ...more].join('\n');
    const names = (s?: string) => (s && !EMPTY.test(s) ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
    if (isNewForm(parts)) {
        // 칸 위치가 정해져 있음: 이름/성별/생년월일/연락처/인도자지역/인도자/인터뷰자/다음 만남/간단정보
        const cell = (i: number) => (parts[i] && !EMPTY.test(parts[i]) && !/^[?？]+$/.test(parts[i]) ? parts[i] : null);
        // 생년월일 칸 없는 양식: 셋째 칸이 연락처, 또는 셋째 칸이 비고 넷째 칸이 지역(글자)
        const noBirth = isPhone(parts[2]) || (blank(parts[2]) && !blank(parts[3]) && !isPhone(parts[3]) && /[가-힣]/.test(parts[3] ?? ''));
        const o = noBirth ? 0 : 1;
        const birthDigits = noBirth ? '' : (cell(2) ?? '').replace(/\D/g, '');
        const phoneCell = cell(2 + o);
        return {
            name,
            followUp,
            gender: parts[1]?.match(GENDER)?.[1] ?? null,
            phone: (phoneCell && (findPhone(phoneCell) ?? (phoneCell.replace(/\D/g, '') || null))) ?? findPhone(all), // 뒷자리만 써도 그대로
            region: cell(3 + o)?.slice(0, 30) ?? null,
            guides: names(cell(4 + o) ?? undefined),
            interviewer: names(cell(5 + o) ?? undefined)[0] ?? null,
            birthDate: birthDigits.length === 6 || birthDigits.length === 8 ? birthDigits : findBirth(all),
            memo: [parts.slice(6 + o).join('/'), ...more].filter(Boolean).join('\n').slice(0, 2000),
        };
    }
    let i = 1;
    let region: string | null = null;
    // 지역 칸 생략 판단: 둘째 칸이 이름 모양이고 이름 칸이 2개 이하로 이어지면 생략된 것 (인도자·인터뷰자는 최대 2칸)
    // shortcut: 지역 생략 + 메모가 '추후연락' 같은 2~4글자면 지역으로 잘못 봄 — 잦으면 지역 목록으로 판별
    let run = 1;
    while (run < parts.length && PEOPLE.test(parts[run])) run++;
    const regionOmitted = parts.length > 1 && NAME_ONLY.test(parts[1]) && !NOT_NAME.test(parts[1]) && run - 1 <= 2;
    if (parts.length > 1 && !regionOmitted) {
        region = EMPTY.test(parts[1]) ? null : parts[1].slice(0, 30);
        i = 2;
    }
    // 이어지는 사람 이름 칸 최대 2개: [인도자, 인터뷰자]. 하나뿐이면 인터뷰자로 봄
    const people: string[] = [];
    while (people.length < 2 && i < parts.length && PEOPLE.test(parts[i])) people.push(parts[i++]);
    const guides = people.length === 2 ? names(people[0]) : [];
    const interviewer = names(people[people.length - 1])[0] ?? null;
    const memo = [parts.slice(i).join('/'), ...more].filter(Boolean).join('\n').slice(0, 2000);
    return { name, followUp, region, guides, interviewer, gender: null, phone: findPhone(all), birthDate: findBirth(all), memo };
}
