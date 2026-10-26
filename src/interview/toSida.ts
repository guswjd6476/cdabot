// 인터뷰 결과 → 특전대 결과 양식 (순수 함수). 인터뷰한 사람은 모두 발굴건, 후속연결 O 는 찾기건도
//   인도지역·인도팀은 행정 members 의 인도자 지역·구역, 없으면 결과지의 지역 칸
import { ParsedForm, ResultValues } from '../sida/result';
import { FollowUp, InterviewKind } from './parse';

export interface GuideInfo {
    region: string | null;
    team: string | null;
}
export interface InterviewLike {
    name: string | null;
    follow_up: FollowUp | null;
    region: string | null;
    guides: string[];
    phone: string | null;
    birth_date: string | null;
    memo: string | null;
    kind: InterviewKind;
}

const PHONE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g;
const p2 = (x: string) => x.padStart(2, '0');
const validMd = (m: string, d: string) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;

// 생년월일 6자리: 생년월일 칸, 메모의 '07.10.12' 또는 '05년생 3.9'
export function birth6(birth: string | null, memo: string): string | null {
    const d = birth?.replace(/\D/g, '');
    if (d && (d.length === 6 || d.length === 8)) return d.slice(-6);
    const text = memo.replace(PHONE, ' ');
    let m = text.match(/(?<![\d.])(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})(?![\d.])/);
    if (m && validMd(m[2], m[3])) return m[1] + p2(m[2]) + p2(m[3]);
    m = text.match(/(\d{2})\s*년생\D{0,3}?(\d{1,2})\s*[.월/]\s*(\d{1,2})/);
    if (m && validMd(m[2], m[3])) return m[1] + p2(m[2]) + p2(m[3]);
    return null;
}

// 생년 구분 (한국 나이): 20~23 초, 24~26 중, 27~29 후, 30대. 그 밖이거나 모르면 null
export function ageGroup(memo: string, b6: string | null, nowYear: number): string | null {
    const yy = b6 ? +b6.slice(0, 2) : Number(memo.match(/(\d{2})\s*년생/)?.[1] ?? NaN);
    let age = Number.isNaN(yy) ? Number(memo.match(/(?<!\d)(\d{2})\s*살/)?.[1] ?? NaN) : nowYear - ((yy <= nowYear % 100 ? 2000 : 1900) + yy) + 1;
    if (Number.isNaN(age)) return null;
    if (age >= 20 && age <= 23) return '20대 초';
    if (age >= 24 && age <= 26) return '20대 중';
    if (age >= 27 && age <= 29) return '20대 후';
    return age >= 30 && age <= 39 ? '30대' : null;
}

// 성별: 메모에 따로 쓴 '남'·'여'·'남성'·'여자' (여자친구 같은 낱말 속 글자는 제외). 둘 다 나오면 null
export function genderOf(memo: string): string | null {
    const g = new Set([...memo.matchAll(/(?<![가-힣])(남|여)(?:성|자)?(?![가-힣])/g)].map((m) => m[1]));
    return g.size === 1 ? [...g][0] : null;
}

// 2차 만남: 결과지 5번째 칸(다음 만남예정일, 장소)이 날짜·요일처럼 보일 때만
export function meetOf(memo: string): { at: string; place: string | null } | null {
    const seg = memo.split('\n')[0].split('/')[0].trim();
    if (!seg || seg.length > 50) return null;
    if (!/\d{1,2}[./]\d{1,2}|평일|주말|요일|(?<![가-힣])[월화수목금토일](?![가-힣])/.test(seg)) return null;
    const i = seg.indexOf(',');
    return i < 0 ? { at: seg, place: null } : { at: seg.slice(0, i).trim(), place: seg.slice(i + 1).trim() || null };
}

const compact = (v: ResultValues): ResultValues => Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as ResultValues;

export function interviewToForms(r: InterviewLike, guide: GuideInfo | undefined, nowYear: number): ParsedForm[] {
    if (!r.name) return [];
    const memo = r.memo ?? '';
    const b6 = birth6(r.birth_date, memo);
    const sheetRegion = r.region && !/^[?？\-–—]+$/.test(r.region) ? r.region : null;
    const common = { name: r.name, region: guide?.region || sheetRegion, team: guide?.team || null, guide: r.guides.join(', ') || null };
    const meet = r.follow_up === 'O' ? meetOf(memo) : null; // 2차 만남이 적힌 발굴 = 답장온 발굴
    const out: ParsedForm[] = [
        {
            kind: 'dig',
            // 연락처는 뒷자리 4자리만
            values: compact({
                ...common,
                phone: r.phone?.replace(/\D/g, '').slice(-4),
                age_group: ageGroup(memo, b6, nowYear),
                gender: genderOf(memo),
                tool: r.kind,
                meet_at: meet?.at,
                meet_place: meet?.place,
            }),
            notes: [],
        },
    ];
    if (r.follow_up === 'O') out.push({ kind: 'find', values: compact({ ...common, birth_date: b6 }), notes: [] });
    return out;
}
