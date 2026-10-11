import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export { dayjs };

export const TZ = 'Asia/Seoul';

export function nowKst() {
    return dayjs().tz(TZ);
}

export function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function escapeHtml(text?: string | number | null): string {
    if (text === undefined || text === null) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// '지역 팀 이름' / '지역/팀/이름' / '지역1팀 이름' 형식 파싱
export function parseMemberString(raw: string): { region: string; team: string; name: string } | null {
    if (!raw) return null;
    const cleaned = raw.trim();

    if (cleaned.includes('/')) {
        const parts = cleaned.split('/').map((s) => s.trim());
        if (parts.length >= 3) {
            return { region: parts[0], team: parts[1].replace(/팀/g, ''), name: parts[2] };
        }
    }

    const spaceParts = cleaned.split(/\s+/).filter(Boolean);
    if (spaceParts.length >= 3) {
        return { region: spaceParts[0], team: spaceParts[1].replace(/팀/g, ''), name: spaceParts[2] };
    }

    if (spaceParts.length === 2) {
        const m = spaceParts[0].match(/^([가-힣]+?)(\d+)팀?$/);
        if (m) {
            return { region: m[1], team: m[2], name: spaceParts[1] };
        }
    }

    return null;
}

/* ====================== 📅 날짜 ====================== */

// 입력 문자열에서 날짜를 찾아 'YYYY-MM-DD'로 변환 (실패 시 null)
// 지원: 10.8(월), 10/8, 10-08, 10월 8일, 2026.10.8, 26.10.8, 오늘/내일/모레
export function parseFlexibleDate(rawText: string): string | null {
    if (!rawText) return null;
    // 전각 숫자·기호(１０．８ 등) → 반각
    const text = rawText.normalize('NFKC');
    const today = nowKst().startOf('day');

    const toYmd = (year: number, month: number, day: number): string | null => {
        const str = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return dayjs(str, 'YYYY-MM-DD', true).isValid() ? str : null; // 2/30 같은 없는 날짜는 거부
    };

    // 연도 포함: 2026.10.8 / 2026년 10월 8일 / 26.10.8 (두 자리 연도는 13 이상일 때만 연도로 인정 → 10.8 14시 오인 방지)
    const withYear = text.match(/(?:^|[^\d])(\d{4}|\d{2})\s*[\-\/\.년]\s*(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (withYear && (withYear[1].length === 4 || parseInt(withYear[1], 10) > 12)) {
        const year = withYear[1].length === 4 ? parseInt(withYear[1], 10) : 2000 + parseInt(withYear[1], 10);
        const ymd = toYmd(year, parseInt(withYear[2], 10), parseInt(withYear[3], 10));
        if (ymd) return ymd;
    }

    // 월·일만: 10.8 / 10/8 / 10-08 / 10월 8일 (뒤의 시간·요일은 무시)
    const monthDay = text.match(/(?:^|[^\d])(\d{1,2})\s*[\-\/\.월]\s*(\d{1,2})(?!\d)/);
    if (monthDay) {
        const month = parseInt(monthDay[1], 10);
        const day = parseInt(monthDay[2], 10);
        // 연도 생략 시 오늘 기준 ±6개월 안에 들어오는 해로 결정 (12월에 1월 입력 → 내년, 1월에 12월 입력 → 작년)
        for (const year of [today.year(), today.year() + 1, today.year() - 1]) {
            const ymd = toYmd(year, month, day);
            if (!ymd) continue;
            const diff = dayjs(ymd).diff(dayjs(today.format('YYYY-MM-DD')), 'day');
            if (diff >= -183 && diff <= 183) return ymd;
        }
        return toYmd(today.year(), month, day);
    }

    const relative = text.match(/오늘|내일|모레/);
    if (relative) {
        const offset = { 오늘: 0, 내일: 1, 모레: 2 }[relative[0] as '오늘' | '내일' | '모레'];
        return today.add(offset, 'day').format('YYYY-MM-DD');
    }

    return null;
}

// 입력한 요일이 실제 날짜의 요일과 다르면 안내 문구 반환 (예: 10.8(월) 인데 10/8이 목요일)
export function getWeekdayWarning(rawText: string, ymd: string): string {
    const text = rawText.normalize('NFKC');
    const m = text.match(/\(\s*([월화수목금토일])(?:요일)?\s*\)|([월화수목금토일])요일/);
    if (!m) return '';
    const written = m[1] || m[2];
    const actual = '일월화수목금토'[dayjs(ymd).day()];
    return written === actual
        ? ''
        : `\n\n⚠️ 입력한 요일(${written})과 실제 요일이 다릅니다: <b>${ymd} (${actual})</b>\n날짜가 틀렸다면 다시 입력해주세요.`;
}

// 지난 날짜면 안내 문구 반환
export function getPastDateWarning(ymd: string): string {
    const todayStr = nowKst().format('YYYY-MM-DD');
    return ymd < todayStr ? `\n\n⚠️ <b>이미 지난 날짜</b>입니다 (${ymd}). 잘못 입력했다면 다시 입력해주세요.` : '';
}

// 입력에서 시간 추출 (예: 19:00, 19시, 오후 7시, 7시 반, 오후 2시 30분) — 표시용 문자열 반환, 없으면 ''
// 오전/오후 표기가 없고 12시 미만이면 입력 그대로 'N시'로 둔다 (오전/오후 추측하지 않음)
export function parseFlexibleTime(rawText: string): string {
    if (!rawText) return '';
    const text = rawText.normalize('NFKC');
    const m =
        text.match(/(오전|오후|아침|새벽|낮|저녁|밤)?\s*(\d{1,2})\s*:\s*(\d{2})(?!\d)/) ||
        text.match(/(오전|오후|아침|새벽|낮|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(?:(\d{1,2})\s*분|(반))?/);
    if (!m) return '';
    let hour = parseInt(m[2], 10);
    const minute = m[4] === '반' ? 30 : m[3] ? parseInt(m[3], 10) : 0;
    if (hour > 24 || minute > 59) return '';
    const period = m[1];
    if (period && ['오후', '저녁', '밤'].includes(period) && hour < 12) hour += 12;
    if (period === '낮' && hour <= 6) hour += 12;
    if (period && ['오전', '아침', '새벽'].includes(period) && hour === 12) hour = 0;
    if (!period && hour < 12) return minute ? `${hour}시 ${minute}분` : `${hour}시`;
    return `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 시간 추출 전에 날짜 부분(10.8 / 2026.10.8 / 10월 8일)을 제거 — '10.8'의 8을 시간으로 오인하지 않도록
export function stripDatePart(rawText: string): string {
    return rawText
        .normalize('NFKC')
        .replace(/(?:(?:\d{4}|1[3-9]|[2-9]\d)\s*[\-\/\.년]\s*)?\d{1,2}\s*[\-\/\.월]\s*\d{1,2}\s*일?/, ' ');
}

// 날짜(+시간) 표시용
export function formatMeetingWhen(date: string, time?: string | null): string {
    return time ? `${date} ${time}` : date;
}

// 날짜 + 요일 표시 (예: 2026-10-08 (목))
export function formatYmdWithDay(ymd: string): string {
    const d = dayjs(ymd);
    return d.isValid() ? `${ymd} (${'일월화수목금토'[d.day()]})` : ymd;
}

/* ====================== 💬 텔레그램 메시지 ====================== */

// 텔레그램 메시지 길이 제한(4096자) 대응: 줄 단위로 나눠 여러 메시지로 전송 (HTML 태그는 줄 안에서 닫혀 있어야 함)
export const TELEGRAM_SAFE_LENGTH = 3800;

export function splitLongMessage(text: string, limit = TELEGRAM_SAFE_LENGTH): string[] {
    const parts: string[] = [];
    let current = '';
    for (const line of text.split('\n')) {
        if (current && current.length + line.length + 1 > limit) {
            parts.push(current);
            current = '';
        }
        current += (current ? '\n' : '') + line;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

export async function replyLong(ctx: any, html: string, lastMessageExtra: Record<string, unknown> = {}) {
    const parts = splitLongMessage(html);
    for (let i = 0; i < parts.length; i++) {
        await ctx.reply(parts[i], { parse_mode: 'HTML', ...(i === parts.length - 1 ? lastMessageExtra : {}) });
    }
}

export async function sendChunkedList<T>(
    ctx: any,
    header: string,
    items: T[],
    renderItem: (item: T, globalIndex: number) => string,
    chunkSize = 15,
    lastMessageExtra: Record<string, unknown> = {}
) {
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        let message =
            i === 0
                ? header
                : `📋 <b>[목록 계속 (${i + 1}~${Math.min(i + chunkSize, items.length)})]</b>\n━━━━━━━━━━━━━━━━━━\n\n`;

        chunk.forEach((item, idx) => {
            message += renderItem(item, i + idx + 1);
        });

        const isLast = i + chunkSize >= items.length;
        await replyLong(ctx, message, isLast ? lastMessageExtra : {});
    }
}
